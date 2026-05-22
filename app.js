window.addEventListener("load", () => {
    /* =====================================================
       MAP
    ===================================================== */
    let stationsLayer = null;
    let cityBoundaryLayer = null;
    let coverageLayer = null;
    let activeRaster = null;
    let coverageChartsActive = false;

    const map = L.map("map", {
        minZoom: 9,
        maxZoom: 18,
        zoomSnap: 0.25,
        zoomDelta: 0.25,
        wheelPxPerZoomLevel: 180
    }).setView(
        [43.59, -79.64],
        11
    );
    window.map = map;

    const osmBase = L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            attribution: "&copy; OpenStreetMap contributors",
            maxZoom: 19
        }
    );

    const cartoLightBase = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        {
            attribution: "&copy; OpenStreetMap &copy; CARTO",
            subdomains: "abcd",
            maxZoom: 20
        }
    );
    osmBase.addTo(map);

    const baseMaps = {
        "OpenStreetMap": osmBase,
        "Carto Light": cartoLightBase
    };

    L.control.layers(baseMaps, null, {
        position: "bottomright",
        collapsed: false
    }).addTo(map);
    L.control.scale().addTo(map);
    requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize(true)));
    document.querySelectorAll('input[name="covRange"]').forEach(radio => {
        radio.addEventListener("change", e => {
            selectedCoverageRange = e.target.value;
            updateCoverageFilter();
        });
    });
    /* =====================================================
       PANES
    ===================================================== */
    const panes = {
        rasters: 200,
        coverage: 700,
        boundary: 850,
        stations: 900
    };

    Object.entries(panes).forEach(([name, z]) => {
        map.createPane(name);
        map.getPane(name).style.zIndex = z;
    });

    map.getPane("popupPane").style.zIndex = 1000;

    const cacheBuster = "?v=" + Date.now();
    /* =====================================================
   MODEL WEIGHTS 
===================================================== */
    let WEIGHTS = { CRITIC: null, RF: null, XGB: null };
    const CANON_ORDER = [
        "Incidents Heatmap",
        "Incidents Response Time",
        "Number of Trucks Dispatched to Incidents",
        "Population Density",
        "Land Use Risk",
        "Road Mobility",
        "Fire Hydrants"
       
    ];

    function canonicalSubsetKey(names) {
        const set = new Set((names || []).map(n => String(n).trim()));
        return CANON_ORDER.filter(n => set.has(n)).join(" | ");
    }
    function escapeHtml(s) {
        return String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
    let WEIGHTS_IDX = { CRITIC: new Map(), RF: new Map(), XGB: new Map() };

    function buildWeightsIndexExact(rawObj) {
        const m = new Map();
        if (!rawObj) return m;
        for (const [k, v] of Object.entries(rawObj)) m.set(String(k).trim(), v);
        return m;
    }

    function getWeightsForSelection(method, selected) {
        const key = canonicalSubsetKey(selected); 
        return WEIGHTS_IDX?.[method]?.get(key) || null;
    }

    async function loadWeights() {
        const [c, r, x] = await Promise.all([
            fetch("./data/weights_critic.json" + cacheBuster).then(res => res.json()),
            fetch("./data/weights_rf.json" + cacheBuster).then(res => res.json()),
            fetch("./data/weights_xgb.json" + cacheBuster).then(res => res.json())
        ]);

        WEIGHTS.CRITIC = c;
        WEIGHTS.RF = r;
        WEIGHTS.XGB = x;
        WEIGHTS_IDX.CRITIC = buildWeightsIndexExact(c);
        WEIGHTS_IDX.RF = buildWeightsIndexExact(r);
        WEIGHTS_IDX.XGB = buildWeightsIndexExact(x);

        console.log("Weights loaded:", {
            CRITIC: WEIGHTS_IDX.CRITIC.size,
            RF: WEIGHTS_IDX.RF.size,
            XGB: WEIGHTS_IDX.XGB.size
        });
    }
    loadWeights().catch(err => console.error("Failed to load weights JSON:", err));

    /* =====================================================
       CHART DATA
    ===================================================== */
    const DRIVE_TIME_DATA = {
        COVERAGE: { "21_24": [10.8, 7.14, 5.68], "24_27": [9.67, 6.41, 3.8] },

        "Incidents Heatmap": { "21_24": [13.88, 7.36, 7.02], "24_27": [9.43, 7.59, 4.51] },
        "Incidents Response Time": { "21_24": [17.93, 5.72, 5.12], "24_27": [15.38, 5.38, 3.34] },
        "Population Density": { "21_24": [13.05, 7.29, 8.06], "24_27": [12.72, 8.37, 6.1] },

        CRITIC: { "21_24": [13.02, 6.7, 6.55], "24_27": [10.6, 7.0, 4.27] },
        RF: { "21_24": [12.26, 7.4, 8.0], "24_27": [8.08, 7.97, 4.75] },
        XGB: { "21_24": [11.65, 7.48, 7.43], "24_27": [8.6, 7.69, 4.41] }
    };

    const HIGH_VERYHIGH_DATA = {
        CRITIC: {
            "21_24": { High: [12.66, 8.81, 6.7], VeryHigh: [20.74, 6.72, 9.13] },
            "24_27": { High: [13.53, 8.85, 5.07], VeryHigh: [13.62, 8.33, 6.46] }
        },
        RF: {
            "21_24": { High: [13.44, 8.76, 5.4], VeryHigh: [14.26, 7.2, 10.61] },
            "24_27": { High: [9.0, 6.6, 5.34], VeryHigh: [5.5, 9.61, 4.96] }
        },
        XGB: {
            "21_24": { High: [14.98, 8.2, 6.84], VeryHigh: [13.11, 8.48, 10.66] },
            "24_27": { High: [9.21, 7.5, 4.91], VeryHigh: [5.21, 9.11, 4.5] }
        }
    };

    const CHART_ONLY_SET = new Set([
        "Incidents Heatmap",
        "Incidents Response Time",
        "Number of Trucks Dispatched to Incidents",
        "Population Density",
        "Land Use Risk"
    ]);

    function isCompositeChartAllowed(selected) {
        if (!selected || selected.length !== 5) return false;

        const s = new Set(selected.map(x => String(x).trim()));
        if (s.size !== 5) return false;

        for (const k of CHART_ONLY_SET) {
            if (!s.has(k)) return false;
        }
        return true;
    }
    /* =====================================================
       CHARTS 
    ===================================================== */
    let driveChartCoverage = null;
    let driveChartRaster = null;
    let chart2124 = null;
    let chart2427 = null;
    let chartsVisible = true;
    let baselineWeights01 = null;
    let deltaWeightsChart = null;

    const el = (id) => document.getElementById(id);
    const setShow = (id, show) => { const n = el(id); if (n) n.style.display = show ? "block" : "none"; };

    function destroyChart(refSetter, chart) {
        if (chart) chart.destroy();
        refSetter(null);
    }

    function makeDriveTimeChart(canvasId, title, d21, d27) {
        const canvas = el(canvasId);
        if (!canvas) return null;

        return new Chart(canvas.getContext("2d"), {
            type: "bar",
            data: {
                labels: ["0–4", "4–6", "6+"],
                datasets: [
                    { label: "21–24 Stations", data: d21, backgroundColor: "#6ec1ff" },
                    { label: "24–27 Stations", data: d27, backgroundColor: "#2ecc71" }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { title: { display: true, text: title }, legend: { position: "bottom" } },
                scales: {
                    x: { title: { display: true, text: "Minutes" } },
                    y: { beginAtZero: true, title: { display: true, text: "Coverage (%)" } }
                }
            }
        });
    }

    function makeHighChart(canvasId, title, high, veryHigh, palette) {
        const canvas = el(canvasId);
        if (!canvas) return null;

        return new Chart(canvas.getContext("2d"), {
            type: "bar",
            data: {
                labels: ["0–4", "4–6", "6+"],
                datasets: [
                    { label: "High", data: high, backgroundColor: palette.light },
                    { label: "Very High", data: veryHigh, backgroundColor: palette.dark }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { title: { display: true, text: title }, legend: { position: "bottom" } },
                scales: {
                    x: { title: { display: true, text: "Minutes" } },
                    y: { beginAtZero: true, title: { display: true, text: "Coverage (%)" } }
                }
            }
        });
    }

    function rasterDriveKey(active) {
        // composites
        if (active === "CRITIC Composite") return "CRITIC";
        if (active === "Random Forest Composite") return "RF";
        if (active === "XGBoost Composite") return "XGB";

        // single layers
        if (active === "Incidents Heatmap") return "Incidents Heatmap";
        if (active === "Incidents Response Time") return "Incidents Response Time";
        if (active === "Population Density") return "Population Density";

        return null;
    }

    const rasterTitle = (k) =>
        k === "CRITIC" ? "CRITIC" : k === "RF" ? "Random Forest" : k === "XGB" ? "XGBoost" : k;

    function clearRasterChartsOnly() {
        if (driveChartRaster) driveChartRaster.destroy();
        driveChartRaster = null;
        if (chart2124) chart2124.destroy();
        if (chart2427) chart2427.destroy();
        chart2124 = chart2427 = null;

        setShow("chartWrap_drive_composite", false);
        setShow("chartWrap_2124", false);
        setShow("chartWrap_2427", false);

        if (!coverageChartsActive) setShow("chartPanel", false);
    }

    function renderRasterCharts(active) {
        clearRasterChartsOnly();

        const key = rasterDriveKey(active);
        if (!key || !DRIVE_TIME_DATA[key]) return;

        setShow("chartPanel", true);
        setShow("chartWrap_drive_composite", chartsVisible);

        driveChartRaster = makeDriveTimeChart(
            "chart_drive_composite",
            `${rasterTitle(key)} – Drive-Time Coverage (minutes)`,
            DRIVE_TIME_DATA[key]["21_24"],
            DRIVE_TIME_DATA[key]["24_27"]
        );

        const isComposite = key === "CRITIC" || key === "RF" || key === "XGB";
        if (isComposite && HIGH_VERYHIGH_DATA[key]) {
            setShow("chartWrap_2124", chartsVisible);
            setShow("chartWrap_2427", chartsVisible);

            chart2124 = makeHighChart(
                "chart_2124",
                `${rasterTitle(key)} – High vs Very High (21–24)`,
                HIGH_VERYHIGH_DATA[key]["21_24"].High,
                HIGH_VERYHIGH_DATA[key]["21_24"].VeryHigh,
                { light: "#6ec1ff", dark: "#1e90ff" }
            );

            chart2427 = makeHighChart(
                "chart_2427",
                `${rasterTitle(key)} – High vs Very High (24–27)`,
                HIGH_VERYHIGH_DATA[key]["24_27"].High,
                HIGH_VERYHIGH_DATA[key]["24_27"].VeryHigh,
                { light: "#7fe0a3", dark: "#2ecc71" }
            );
        }
    }
    function setSlidersFromWeights01(w01) {
        if (!w01) return;

     
        CANON_ORDER.forEach((key) => {
            setSliderByKey(key, w01[key] ?? 0);
        });

        if (map.hasLayer(compositeLayer)) compositeLayer.redraw();
        updateLiveChangeUI();
    }

    /* =====================================================
   LIVE DELTA UI (Baseline + Change Summary + Delta Chart)
===================================================== */
    function getNormalizedWeights01() {
        const raw = {};
        document.querySelectorAll('#weights input[type="range"]').forEach((r) => {
            raw[r.dataset.key] = parseFloat(r.value);
        });

        const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;

        const w01 = {};
        for (const k in raw) w01[k] = raw[k] / sum;
        return w01;
    }

    function getSelectedIndicators() {
        return [...document.querySelectorAll('.modelLayer:checked')].map(n => n.value);
    }

    function prettyPct(x) {
        return (100 * (x ?? 0)).toFixed(1) + "%";
    }

    function setBaselineToCurrent() {
        baselineWeights01 = getNormalizedWeights01();

        const status = el("baselineStatus");
        if (status) status.textContent = "Baseline: set (current sliders)";

        el("btnResetBaseline")?.removeAttribute("disabled");
        el("btnClearBaseline")?.removeAttribute("disabled");
        setShow("deltaChartWrap", true);

        updateLiveChangeUI();
    }

    function resetToBaseline() {
        if (!baselineWeights01) return;
        setSlidersFromWeights01(baselineWeights01);
    }

    function clearBaseline() {
        baselineWeights01 = null;

        const status = el("baselineStatus");
        if (status) status.textContent = "Baseline: not set";

        el("btnResetBaseline")?.setAttribute("disabled", "disabled");
        el("btnClearBaseline")?.setAttribute("disabled", "disabled");
        setShow("deltaChartWrap", false);

        if (deltaWeightsChart) {
            deltaWeightsChart.destroy();
            deltaWeightsChart = null;
        }

        updateLiveChangeUI();
    }

    function computeDeltas(current01, base01) {
        return CANON_ORDER.map(name => ({
            name,
            cur: current01[name] ?? 0,
            base: base01[name] ?? 0,
            delta: (current01[name] ?? 0) - (base01[name] ?? 0)
        }));
    }

    function renderChangeSummary(deltaArr) {
        const wrap = el("changeSummary");
        if (!wrap) return;

        const selected = getSelectedIndicators();
        const activeCount = selected.length;

        const topCur = [...deltaArr]
            .sort((a, b) => b.cur - a.cur)
            .slice(0, 3)
            .filter(d => d.cur > 0);

        const up = [...deltaArr].sort((a, b) => b.delta - a.delta).slice(0, 2);
        const down = [...deltaArr].sort((a, b) => a.delta - b.delta).slice(0, 2);

        const baselineOk = !!baselineWeights01;

        wrap.innerHTML = `
        <div><strong>Live change summary</strong></div>
        <div>Selected indicators: <strong>${activeCount}</strong> (${selected.map(escapeHtml).join(", ") || "none"})</div>
        <div>Top weights now: ${topCur.length
                ? topCur.map(d => `<span><strong>${escapeHtml(d.name)}</strong> (${prettyPct(d.cur)})</span>`).join(" • ")
                : "<span>none</span>"
            }</div>
        <div style="margin-top:4px;">
            ${baselineOk ? `
                <div>Biggest increases vs baseline: ${up.map(d => `<span><strong>${escapeHtml(d.name)}</strong> (${(d.delta >= 0 ? "+" : "") + (100 * d.delta).toFixed(1)}%)</span>`).join(" • ")
                }</div>
                <div>Biggest decreases vs baseline: ${down.map(d => `<span><strong>${escapeHtml(d.name)}</strong> (${(d.delta >= 0 ? "+" : "") + (100 * d.delta).toFixed(1)}%)</span>`).join(" • ")
                }</div>
            ` : `<div style="opacity:0.85;">Tip: click <strong>Set current as baseline</strong> to enable delta comparisons.</div>`}
        </div>
    `;
    }

    function renderDeltaWeightsChart(deltaArr) {
        const canvas = el("chart_delta_weights");
        if (!canvas) return;

        const labels = deltaArr.map(d => d.name);
        const data = deltaArr.map(d => +(d.delta.toFixed(6)));

        if (deltaWeightsChart) deltaWeightsChart.destroy();

        deltaWeightsChart = new Chart(canvas.getContext("2d"), {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: "Δ weight (current − baseline)",
                    data
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                plugins: {
                    legend: { display: true, position: "bottom" },
                    title: { display: true, text: "Indicator weight changes (approx)" },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const v = ctx.raw || 0;
                                return ` Δ ${(100 * v).toFixed(1)}%`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: "Δ weight" },
                        ticks: { callback: (v) => (100 * v).toFixed(0) + "%" }
                    },
                    y: { ticks: { autoSkip: false } }
                }
            }
        });
    }

    function debounce(fn, ms = 120) {
        let t = null;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...args), ms);
        };
    }

    const updateLiveChangeUI = debounce(() => {
        const current01 = getNormalizedWeights01();
        if (!baselineWeights01) {
            renderChangeSummary(
                CANON_ORDER.map(n => ({
                    name: n,
                    cur: current01[n] ?? 0,
                    base: 0,
                    delta: 0
                }))
            );

            if (deltaWeightsChart) {
                deltaWeightsChart.destroy();
                deltaWeightsChart = null;
            }

            setShow("deltaChartWrap", false);   
            return;
        }

        const deltaArr = computeDeltas(current01, baselineWeights01);
        renderChangeSummary(deltaArr);
        renderDeltaWeightsChart(deltaArr);
        setShow("deltaChartWrap", true);  
    }, 120);
    /* =====================================================
       SAFE TILE LAYER + RASTER LAYERS
    ===================================================== */
    const SafeTileLayer = L.TileLayer.extend({
        initialize(root, options) {
            this._root = root;
            L.TileLayer.prototype.initialize.call(this, "{z}/{x}/{y}.png", options || {});
        },
        getTileUrl(coords) {
            return `${this._root}/${coords.z}/${coords.x}/${coords.y}.png${cacheBuster}`;
        }
    });

    const layers = {
        "Incidents Heatmap": new SafeTileLayer("./data/Incidents_Heatmap", { pane: "rasters" }),
        "Population Density": new SafeTileLayer("./data/Pop_Density", { pane: "rasters" }),
        "Fire Hydrants": new SafeTileLayer("./data/Fire_Hydrants", { pane: "rasters" }),
        "Road Mobility": new SafeTileLayer("./data/Road_Mobility", { pane: "rasters" }),
        "Number of Trucks Dispatched to Incidents": new SafeTileLayer("./data/Trucks", { pane: "rasters" }),
        "Incidents Response Time": new SafeTileLayer("./data/Response_Time", { pane: "rasters" }),
        "Land Use Risk": new SafeTileLayer("./data/Land_Use", { pane: "rasters" })
        
    };

    // VALUE tiles 
    const valueSources = {
        "Incidents Heatmap": new SafeTileLayer("./data/Incidents_Heatmap_VAL", { pane: "rasters" }),
        "Incidents Response Time": new SafeTileLayer("./data/Response_Time_VAL", { pane: "rasters" }),
        "Number of Trucks Dispatched to Incidents": new SafeTileLayer("./data/Trucks_VAL", { pane: "rasters" }),
        "Population Density": new SafeTileLayer("./data/Pop_Density_VAL", { pane: "rasters" }),
        "Fire Hydrants": new SafeTileLayer("./data/Fire_Hydrants_VAL", { pane: "rasters" }),
        "Land Use Risk": new SafeTileLayer("./data/Land_Use_VAL", { pane: "rasters" }),
        "Road Mobility": new SafeTileLayer("./data/Road_Mobility_VAL", { pane: "rasters" })
    };
    /* =====================================================
       MANUAL COMPOSITE 
    ===================================================== */
    const colorSources = {
        "Incidents Heatmap": layers["Incidents Heatmap"],
        "Incidents Response Time": layers["Incidents Response Time"],
        "Number of Trucks Dispatched to Incidents": layers["Number of Trucks Dispatched to Incidents"],
        "Population Density": layers["Population Density"],
        "Land Use Risk": layers["Land Use Risk"],
        "Road Mobility": layers["Road Mobility"],
        "Fire Hydrants": layers["Fire Hydrants"]     
    };

    function buildModelLayerList() {
        const wrap = el("modelLayerList");
        if (!wrap) return;

        wrap.innerHTML = "";

        Object.keys(colorSources).forEach(name => {
            const row = document.createElement("label");
            row.style.display = "block";

            const checked = (name !== "Road Mobility" && name !== "Fire Hydrants") ? "checked" : "";
            row.innerHTML = `<input class="modelLayer" type="checkbox" value="${name}" ${checked}> ${name}`;
            wrap.appendChild(row);
            row.querySelector("input")?.addEventListener("change", () => {
                updateLiveChangeUI();
            });
        });
    }
    buildModelLayerList();

    function turbo(t) {
        t = Math.max(0, Math.min(1, t));

        const r = 0.13572138 + t * (4.61539260 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
        const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
        const b = 0.10667330 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
        const R = Math.round(255 * Math.max(0, Math.min(1, r)));
        const G = Math.round(255 * Math.max(0, Math.min(1, g)));
        const B = Math.round(255 * Math.max(0, Math.min(1, b)));

        return [R, G, B];
    }

    const CompositeLayer = L.GridLayer.extend({
        createTile(coords, done) {
            const tile = L.DomUtil.create("canvas", "leaflet-tile");
            const size = this.getTileSize();
            tile.width = size.x;
            tile.height = size.y;

            const ctx = tile.getContext("2d");
            const keys = Object.keys(valueSources);

            Promise.all(
                keys.map(
                    (k) =>
                        new Promise((res) => {
                            const img = new Image();
                            img.crossOrigin = "anonymous";
                            img.onload = () => res({ k, img });
                            img.onerror = () => res({ k, img: null });
                            img.src = valueSources[k].getTileUrl(coords);
                        })
                )
            ).then((parts) => {
                const off = document.createElement("canvas");
                off.width = size.x;
                off.height = size.y;
                const octx = off.getContext("2d");
                const raw = {};
                document.querySelectorAll('#weights input[type="range"]').forEach((r) => {
                    raw[r.dataset.key] = parseFloat(r.value);
                });

                const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
                const weights = {};
                for (const k in raw) weights[k] = raw[k] / sum;
                document.querySelectorAll('#weights input[type="range"]').forEach((r) => {
                    const out = document.querySelector(`span[data-out="${r.dataset.key}"]`);
                    if (out) out.textContent = weights[r.dataset.key].toFixed(2);
                });

                const acc = new Float32Array(size.x * size.y);

                parts.forEach(({ k, img }) => {
                    const w = weights[k] || 0;
                    if (!img || w === 0) return;

                    octx.clearRect(0, 0, size.x, size.y);
                    octx.drawImage(img, 0, 0, size.x, size.y);
                    const d = octx.getImageData(0, 0, size.x, size.y).data;

                    for (let i = 0, p = 0; i < acc.length; i++, p += 4) {
                        if (d[p + 3] === 0) continue;
                        acc[i] += (d[p] / 255) * w; 
                    }
                });

                
                {
                    const sm = new Float32Array(acc.length);

                    for (let y = 1; y < size.y - 1; y++) {
                        for (let x = 1; x < size.x - 1; x++) {
                            const i = y * size.x + x;
                            sm[i] = (
                                acc[i] +
                                acc[i - 1] + acc[i + 1] +
                                acc[i - size.x] + acc[i + size.x] +
                                acc[i - size.x - 1] + acc[i - size.x + 1] +
                                acc[i + size.x - 1] + acc[i + size.x + 1]
                            ) / 9;
                        }
                    }

                    
                    for (let x = 0; x < size.x; x++) {
                        sm[x] = acc[x];
                        sm[(size.y - 1) * size.x + x] = acc[(size.y - 1) * size.x + x];
                    }
                    for (let y = 0; y < size.y; y++) {
                        sm[y * size.x] = acc[y * size.x];
                        sm[y * size.x + (size.x - 1)] = acc[y * size.x + (size.x - 1)];
                    }

                    acc.set(sm);
                }

                const sample = [];
                const step = 8;
                for (let i = 0; i < acc.length; i += step) {
                    const v = acc[i];
                    if (v > 0 && Number.isFinite(v)) sample.push(v);
                }
                sample.sort((a, b) => a - b);

                let P02 = 0, P98 = 1;
                if (sample.length > 50) {
                    P02 = sample[Math.floor(0.02 * (sample.length - 1))];
                    P98 = sample[Math.floor(0.98 * (sample.length - 1))];
                    if (P98 <= P02) { P02 = sample[0]; P98 = sample[sample.length - 1]; }
                }

                const gamma = 2; 
                const outImg = ctx.createImageData(size.x, size.y);

                for (let i = 0, p = 0; i < acc.length; i++, p += 4) {
                    let t = acc[i];

                    t = (t - P02) / (P98 - P02);
                    t = Math.max(0, Math.min(1, t));

                    t = Math.pow(t, gamma);

                    const [r, g, b] = turbo(t);
                    outImg.data[p] = r;
                    outImg.data[p + 1] = g;
                    outImg.data[p + 2] = b;
                    outImg.data[p + 3] = (t > 0 ? 255 : 0);
                }

                ctx.putImageData(outImg, 0, 0);
                done(null, tile);
            });

            return tile;
        }
    });
    const compositeLayer = new CompositeLayer({ pane: "rasters", opacity: 0.9 });
    document.querySelectorAll('#weights input[type="range"]').forEach((sl) =>
        sl.addEventListener("input", () => {
            if (map.hasLayer(compositeLayer)) compositeLayer.redraw();
            updateLiveChangeUI();
        })
    );
    /* =====================================================
   MODEL COMPOSITE 
===================================================== */
    function setSliderByKey(key, w01) {
        const slider = document.querySelector(`#weights input[type="range"][data-key="${key}"]`);
        if (!slider) return false;

        const min = parseFloat(slider.min || "0");
        const max = parseFloat(slider.max || "1");
        const v = min + (max - min) * w01; 
        slider.value = String(v);

        const out = document.querySelector(`span[data-out="${key}"]`);
        if (out) out.textContent = Number(w01).toFixed(2);

        return true;
    }

    function setAllSlidersZero() {
        document.querySelectorAll('#weights input[type="range"]').forEach(r => {
            r.value = r.min ?? "0";
            const out = document.querySelector(`span[data-out="${r.dataset.key}"]`);
            if (out) out.textContent = "0.00";
        });
    }

    function getSelectedModelLayers() {
        return [...document.querySelectorAll('.modelLayer:checked')].map(n => n.value);
    }
    function isValidSubset(selected) {
        return selected.length >= 2;
    }

    let ACTIVE_METHOD = null; 

    function applyModelComposite(method) {
        ACTIVE_METHOD = method;

        const selected = getSelectedModelLayers();

        if (selected.length < 2) {
            console.warn("Select at least 2 layers.");
            setAllSlidersZero();
            compositeLayer.redraw();
            clearRasterChartsOnly();
            updateLiveChangeUI();
            return;
        }

        const w = getWeightsForSelection(method, selected);

        if (!w) {
            console.warn("No weights found for subset:", canonicalSubsetKey(selected), "method:", method);
            setAllSlidersZero();
            compositeLayer.redraw();
            clearRasterChartsOnly();
            updateLiveChangeUI();
            return;
        }

        
        Object.keys(colorSources).forEach(layerName => {
            setSliderByKey(layerName, w[layerName] ?? 0);
        });

        if (map.hasLayer(compositeLayer)) compositeLayer.redraw();

        if (isCompositeChartAllowed(selected)) {
            setShow("chartPanel", true);

            const pseudoName =
                method === "CRITIC" ? "CRITIC Composite" :
                    method === "RF" ? "Random Forest Composite" :
                        "XGBoost Composite";

            renderRasterCharts(pseudoName);
        } else {
            clearRasterChartsOnly();
        }
    }
    el("btnCRITIC")?.addEventListener("click", () => applyModelComposite("CRITIC"));
    el("btnRF")?.addEventListener("click", () => applyModelComposite("RF"));
    el("btnXGB")?.addEventListener("click", () => applyModelComposite("XGB"));
    el("btnSetBaseline")?.addEventListener("click", setBaselineToCurrent);
    el("btnResetBaseline")?.addEventListener("click", resetToBaseline);
    el("btnClearBaseline")?.addEventListener("click", clearBaseline);

    /* =====================================================
       RASTER CONTROL
    ===================================================== */
    function clearRasters() {
        Object.values(layers).forEach(l => map.removeLayer(l));
        if (map.hasLayer(compositeLayer)) map.removeLayer(compositeLayer);
        activeRaster = null;
        setShow("modelPanel", false);
    }

    function applyRasterSelection(name) {
        clearRasters();
        activeRaster = name;

        const hideBox = el("chkHideRasters");
        if (hideBox) hideBox.checked = false;

        if (activeRaster === "__COMPOSITE__") {
            setShow("weights", true);
            setShow("modelPanel", true);
            compositeLayer.addTo(map);
            clearRasterChartsOnly();
            updateLiveChangeUI();

        } else {
            setShow("weights", false);
            setShow("modelPanel", false);

            if (layers[activeRaster]) layers[activeRaster].addTo(map);
            renderRasterCharts(activeRaster);
        }
    }

    document.querySelectorAll('input[name="r"]').forEach((radio) => {
        radio.addEventListener("change", (e) => {
            if (e.target.checked) applyRasterSelection(e.target.value);
        });
    });

    const chkHideRasters = el("chkHideRasters");
    if (chkHideRasters) {
        chkHideRasters.addEventListener("change", (e) => {
            if (!e.target.checked) return;

            clearRasters();
            setShow("weights", false);
            document.querySelectorAll('input[name="r"]').forEach((r) => (r.checked = false));
            clearRasterChartsOnly();
        });
    }

    /* =====================================================
       COVERAGE POLYGON + COVERAGE CHART
    ===================================================== */
    function driveTimeColor(dt) {
        if (dt === "0 - 4") return "#006d6f";   
        if (dt === "4 - 6") return "#2aa198";   
        if (dt === "6 - 8") return "#b2dfdb";      
        return "#ccc";
    }

    fetch("./data/Fire_Stations_Service_Coverage.geojson?v=" + Date.now())
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status} while loading coverage geojson`);
            return r.text();
        })
        .then((t) => {
            if (!t || t.trim().length === 0) throw new Error("Coverage geojson is empty");
            if (t.trim().startsWith("<")) throw new Error("HTML returned instead of GeoJSON");
            return JSON.parse(t);
        })
        .then((d) => {
            d.features.sort((a, b) => {
                const order = { "6 - 8": 0, "4 - 6": 1, "0 - 4": 2 };
                return (order[a.properties?.Drive_Time] ?? 0) - (order[b.properties?.Drive_Time] ?? 0);
            });

            coverageLayer = L.geoJSON(d, {
                pane: "coverage",
                style: (f) => ({
                    color: "#444",
                    weight: 1.2,
                    fillColor: driveTimeColor(f.properties?.Drive_Time),
                    fillOpacity: 0.45
                })
            });
        })
        .catch((err) => console.error("Coverage GeoJSON load failed:", err));

    const legend = el("coverage-legend");
    const chkCoverage = el("chkCoverage");

    function enforceStationZOrder() {
        const chkStations = el("chkStations");
        if (!chkStations || !chkStations.checked) return;
        if (stationsLayer && map.hasLayer(stationsLayer)) stationsLayer.bringToFront();
    }

    let selectedCoverageRange = "ALL";

    function updateCoverageFilter() {
        if (!coverageLayer) return;

        coverageLayer.eachLayer(layer => {
            const dt = layer.feature?.properties?.Drive_Time;

            if (selectedCoverageRange === "ALL") {
                layer.setStyle({ fillOpacity: 0.55 });
            } else {
                layer.setStyle({ fillOpacity: (dt === selectedCoverageRange) ? 0.55 : 0 });
            }
        });
    }

    if (chkCoverage) {
        chkCoverage.addEventListener("change", (e) => {
            const on = e.target.checked;

            if (on) {
                if (coverageLayer) coverageLayer.addTo(map);
                enforceStationZOrder();
                if (legend) legend.style.display = "block";

                if (el("coverageFilter")) el("coverageFilter").style.display = "grid";

                updateCoverageFilter();

                coverageChartsActive = true;
                setShow("chartPanel", true);
                setShow("chartWrap_drive_coverage", chartsVisible);

                if (driveChartCoverage) driveChartCoverage.destroy();
                driveChartCoverage = makeDriveTimeChart(
                    "chart_drive_coverage",
                    "Service Coverage Drive-Time",
                    DRIVE_TIME_DATA.COVERAGE["21_24"],
                    DRIVE_TIME_DATA.COVERAGE["24_27"]
                );

            } else {
                if (coverageLayer) map.removeLayer(coverageLayer);
                if (legend) legend.style.display = "none";

                if (el("coverageFilter")) el("coverageFilter").style.display = "none";

                coverageChartsActive = false;
                if (driveChartCoverage) driveChartCoverage.destroy();
                driveChartCoverage = null;
                setShow("chartWrap_drive_coverage", false);

                if (!driveChartRaster && !chart2124 && !chart2427) setShow("chartPanel", false);
            }
        });
    }

    /* =====================================================
       STATIONS
    ===================================================== */
    const flashingBlue = [];
    const flashingGreen = [];

    function makeStationIcon(color, opacity = 1) {
        return L.divIcon({
            className: "",
            html: `
            <div style="
                width: 24px;
                height: 24px;
                border-radius: 6px;
                background: ${color};
                border: 2px solid #111;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 1px 4px rgba(0,0,0,0.35);
                opacity: ${opacity};
                font-size: 14px;
            ">
                🚒
            </div>
        `,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            popupAnchor: [0, -12]
        });
    }

    const defaultStationIcon = makeStationIcon("#ffffff", 1);
    const blueOn = makeStationIcon("#1e90ff", 1);
    const blueOff = makeStationIcon("#1e90ff", 0.25);
    const greenOn = makeStationIcon("#2ecc71", 1);
    const greenOff = makeStationIcon("#2ecc71", 0.25);

    fetch("./data/Fire_Stations.geojson?v=" + Date.now())
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status} while loading stations geojson`);
            return r.text();
        })
        .then((t) => {
            if (!t || t.trim().length === 0) throw new Error("Stations geojson is empty");
            if (t.trim().startsWith("<")) throw new Error("HTML returned instead of GeoJSON");
            return JSON.parse(t);
        })
        .then((d) => {
            stationsLayer = L.geoJSON(d, {
                pane: "stations",

                pointToLayer: (feature, latlng) => {

                    const props = feature.properties;
                    const id = props?.Station_ID;
                    const address = props?.Address;
                    const site = props?.Site_Name;

                    let icon = defaultStationIcon;
                    if ([123, 124, 125].includes(id)) icon = blueOn;
                    if ([126, 127, 128].includes(id)) icon = greenOn;

                    const marker = L.marker(latlng, { icon, pane: "stations" });

                    const popupContent = `
        <div class="station-popup">
            <div><strong>Station ${escapeHtml(id)}</strong></div>
            <div>${escapeHtml(address)}</div>
        </div>
    `;

                    marker.bindPopup(popupContent, {
                        maxWidth: 260,
                        autoPan: true
                    });

                    if ([123, 124, 125].includes(id)) flashingBlue.push(marker);
                    if ([126, 127, 128].includes(id)) flashingGreen.push(marker);

                    return marker;
                }
            });

            const chkStations = el("chkStations");
            if (!chkStations || chkStations.checked) {
                stationsLayer.addTo(map);
                enforceStationZOrder();
            }
        })
        .catch((err) => console.error("🔥 Fire Stations load failed:", err));

    const chkStations = el("chkStations");
    if (chkStations) {
        chkStations.addEventListener("change", (e) => {
            const pane = map.getPane("stations");
            if (e.target.checked) {
                if (stationsLayer && !map.hasLayer(stationsLayer)) stationsLayer.addTo(map);
                if (pane) pane.style.display = "";
                enforceStationZOrder();
            } else {
                if (stationsLayer) map.removeLayer(stationsLayer);
                if (pane) pane.style.display = "none";
            }
        });
    }

    setInterval(() => {
        flashingBlue.forEach((m) => m.setIcon(m.options.icon === blueOn ? blueOff : blueOn));
        flashingGreen.forEach((m) => m.setIcon(m.options.icon === greenOn ? greenOff : greenOn));
    }, 600);

    fetch("./data/City_Boundary.geojson?v=" + Date.now())
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status} while loading city boundary geojson`);
            return r.text();
        })
        .then((t) => {
            if (!t || t.trim().length === 0) throw new Error("City boundary geojson is empty");
            if (t.trim().startsWith("<")) throw new Error("HTML returned instead of GeoJSON");
            return JSON.parse(t);
        })
        .then((d) => {
            cityBoundaryLayer = L.geoJSON(d, {
                pane: "boundary",
                style: {
                    color: "#111",
                    weight: 2.5,
                    opacity: 0.9,
                    fill: false
                }
            });

            const chk = el("chkCityBoundary");
            if (!chk || chk.checked) cityBoundaryLayer.addTo(map);
        })
        .catch((err) => console.error("🔥 City Boundary load failed:", err));
    const chkCityBoundary = el("chkCityBoundary");
    if (chkCityBoundary) {
        chkCityBoundary.addEventListener("change", (e) => {
            if (!cityBoundaryLayer) return;

            if (e.target.checked) {
                if (!map.hasLayer(cityBoundaryLayer)) cityBoundaryLayer.addTo(map);
                enforceStationZOrder(); 
            } else {
                map.removeLayer(cityBoundaryLayer);
            }
        });
    }
    /* =====================================================
   CHART PANEL COLLAPSE
===================================================== */
    const chartBtn = el("toggleCharts");
    const chartPanel = el("chartPanel");

    if (chartBtn && chartPanel) {

        chartBtn.addEventListener("click", () => {

            chartPanel.classList.toggle("collapsed");

            const isCollapsed = chartPanel.classList.contains("collapsed");

            chartBtn.setAttribute(
                "aria-expanded",
                String(!isCollapsed)
            );

            chartBtn.textContent =
                isCollapsed
                    ? "📊 Show Charts"
                    : "📊 Charts";
        });
    }
    // RESET VIEW 
    el("btnResetView")?.addEventListener("click", () => {

        map.setView([43.59, -79.64], 11);

        document.querySelectorAll('input[name="r"]').forEach(r => {
            r.checked = false;
        });

        const hideBox = el("chkHideRasters");
        if (hideBox) hideBox.checked = false;

        clearRasters();
        clearRasterChartsOnly();

        setTimeout(() => {
            map.invalidateSize(true);
        }, 200);

    });
    el("btnInfo")?.addEventListener("click", () => {
        const popup = el("infoPopup");
        if (!popup) return;

        popup.style.display =
            popup.style.display === "block" ? "none" : "block";
    });

    // FULLSCREEN
    el("btnFullscreen")?.addEventListener("click", () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    });
   
});
