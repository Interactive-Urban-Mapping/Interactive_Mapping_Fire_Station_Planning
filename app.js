window.addEventListener("load", () => {
    if (window.Chart) Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

    let stationsLayer = null;
    let cityBoundaryLayer = null;
    let coverageLayers = {};
    let activeCoverageKey = null;
    let activeRaster = null;

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
            attribution: "&copy; OpenStreetMap contributors | Processed with QGIS",
            maxZoom: 19
        }
    );

    const lightGrayBase = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        {
            attribution: "Tiles &copy; Esri | Processed with QGIS",
            maxNativeZoom: 16,
            maxZoom: 19
        }
    );

    const darkGrayBase = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        {
            attribution: "Tiles &copy; Esri | Processed with QGIS",
            maxNativeZoom: 16,
            maxZoom: 19
        }
    );
    osmBase.addTo(map);

    const baseMaps = {
        "OpenStreetMap Standard": osmBase,
        "Light Gray (keyless)": lightGrayBase,
        "Dark Gray (keyless)": darkGrayBase
    };

    const baseLayerControl = L.control.layers(baseMaps, null, {
        position: "bottomright",
        collapsed: true
    }).addTo(map);
    const baseLayerControlContainer = baseLayerControl.getContainer();
    baseLayerControlContainer.setAttribute("aria-label", "Basemap options");
    const baseLayerList = baseLayerControlContainer.querySelector(".leaflet-control-layers-list");
    if (baseLayerList) {
        const baseLayerTitle = document.createElement("div");
        baseLayerTitle.className = "basemap-control-title";
        baseLayerTitle.textContent = "Basemap";
        baseLayerList.prepend(baseLayerTitle);
    }
    L.control.scale().addTo(map);
    requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize(true)));
    document.querySelectorAll('input[name="covRange"]').forEach(radio => {
        radio.addEventListener("change", e => {
            selectedCoverageRange = e.target.value;
            updateCoverageFilter();
        });
    });

    document.querySelectorAll('input[name="serviceAreaChoice"]').forEach(radio => {
        radio.addEventListener("change", e => {
            applyServiceAreaSelection(e.target.value);
        });
    });
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

    const CHART_DATA_PATH = "./data/chart_data/";
    let DRIVE_TIME_DATA = {};
    let HIGH_VERYHIGH_DATA = {};
    let chartDataLoadFailed = false;

    function parseCsvRows(text) {
        const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
        if (!lines.length) return [];

        const headers = lines[0].replace(/^\uFEFF/, "").split(",").map(h => h.trim());
        return lines.slice(1).map(line => {
            const cols = line.split(",").map(c => c.trim());
            return headers.reduce((row, header, i) => {
                row[header] = cols[i] ?? "";
                return row;
            }, {});
        });
    }

    function chartValues(row) {
        return [
            Number(row.minutes_0_4),
            Number(row.minutes_4_6),
            Number(row.minutes_6_plus)
        ];
    }

    async function loadChartData() {
        const [driveCsv, highCsv] = await Promise.all([
            fetch(CHART_DATA_PATH + "drive_time_coverage.csv" + cacheBuster).then(res => res.text()),
            fetch(CHART_DATA_PATH + "high_very_high.csv" + cacheBuster).then(res => res.text())
        ]);

        const driveData = {};
        parseCsvRows(driveCsv).forEach(row => {
            const key = row.chart_key;
            if (!driveData[key]) driveData[key] = {};
            driveData[key][row.scenario] = chartValues(row);
        });

        const highData = {};
        parseCsvRows(highCsv).forEach(row => {
            const method = row.method;
            if (!highData[method]) highData[method] = {};
            if (!highData[method][row.scenario]) highData[method][row.scenario] = {};
            highData[method][row.scenario][row.priority_class] = chartValues(row);
        });

        DRIVE_TIME_DATA = driveData;
        HIGH_VERYHIGH_DATA = highData;
    }

    const chartDataReady = loadChartData().catch(err => {
        console.error("Failed to load chart CSV data:", err);
        chartDataLoadFailed = true;
        DRIVE_TIME_DATA = {};
        HIGH_VERYHIGH_DATA = {};
    });
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
    let driveChartCoverage = null;
    let driveChartRaster = null;
    let chart2124 = null;
    let chart2427 = null;
    let chartsVisible = true;
    let baselineWeights01 = null;
    let deltaWeightsChart = null;

    const el = (id) => document.getElementById(id);
    const setShow = (id, show) => { const n = el(id); if (!n) return; if (id === "chartPanel") { n.style.display = "block"; return; } n.style.display = show ? "block" : "none"; };

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
                labels: ["0-4", "4-6", "6+"],
                datasets: [
                    { label: "21-24 Stations", data: d21, backgroundColor: "#6ec1ff" },
                    { label: "24-27 Stations", data: d27, backgroundColor: "#2ecc71" }
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
                labels: ["0-4", "4-6", "6+"],
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
        if (active === "CRITIC Composite") return "CRITIC";
        if (active === "Random Forest Composite") return "RF";
        if (active === "XGBoost Composite") return "XGB";

        if (active === "Incidents Heatmap") return "Incidents Heatmap";
        if (active === "Incidents Response Time") return "Incidents Response Time";
        if (active === "Population Density") return "Population Density";

        return null;
    }

    const rasterTitle = (k) =>
        k === "CRITIC" ? "CRITIC" : k === "RF" ? "Random Forest" : k === "XGB" ? "XGBoost" : k;


    function clearChartPanel() {
        if (driveChartCoverage) driveChartCoverage.destroy();
        if (driveChartRaster) driveChartRaster.destroy();
        if (chart2124) chart2124.destroy();
        if (chart2427) chart2427.destroy();
        driveChartCoverage = null;
        driveChartRaster = null;
        chart2124 = null;
        chart2427 = null;
        setShow("chartWrap_drive_coverage", false);
        setShow("chartWrap_drive_composite", false);
        setShow("chartWrap_2124", false);
        setShow("chartWrap_2427", false);
        setShow("chartEmpty", true);
    }

    function renderDashboardChart(key) {
        clearChartPanel();
        if (!key) return;

        if (!DRIVE_TIME_DATA[key]) {
            if (!chartDataLoadFailed) {
                chartDataReady.then(() => {
                    if (DRIVE_TIME_DATA[key]) renderDashboardChart(key);
                });
            }
            return;
        }

        setShow("chartEmpty", false);

        if (key === "COVERAGE") {
            setShow("chartWrap_drive_coverage", chartsVisible);
            driveChartCoverage = makeDriveTimeChart(
                "chart_drive_coverage",
                "Service Coverage Drive-Time",
                DRIVE_TIME_DATA.COVERAGE["21_24"],
                DRIVE_TIME_DATA.COVERAGE["24_27"]
            );
            return;
        }

        setShow("chartWrap_drive_composite", chartsVisible);
        driveChartRaster = makeDriveTimeChart(
            "chart_drive_composite",
            `${rasterTitle(key)} - Drive-Time Coverage (minutes)`,
            DRIVE_TIME_DATA[key]["21_24"],
            DRIVE_TIME_DATA[key]["24_27"]
        );

        const isComposite = key === "CRITIC" || key === "RF" || key === "XGB";
        if (isComposite && HIGH_VERYHIGH_DATA[key]) {
            setShow("chartWrap_2124", chartsVisible);
            setShow("chartWrap_2427", chartsVisible);

            chart2124 = makeHighChart(
                "chart_2124",
                `${rasterTitle(key)} - High vs Very High (21-24)`,
                HIGH_VERYHIGH_DATA[key]["21_24"].High,
                HIGH_VERYHIGH_DATA[key]["21_24"].VeryHigh,
                { light: "#6ec1ff", dark: "#1e90ff" }
            );

            chart2427 = makeHighChart(
                "chart_2427",
                `${rasterTitle(key)} - High vs Very High (24-27)`,
                HIGH_VERYHIGH_DATA[key]["24_27"].High,
                HIGH_VERYHIGH_DATA[key]["24_27"].VeryHigh,
                { light: "#7fe0a3", dark: "#2ecc71" }
            );
        }
    }

    document.querySelectorAll('input[name="chartChoice"]').forEach((radio) => {
        radio.addEventListener("change", (e) => renderDashboardChart(e.target.value));
    });

    el("btnClearCharts")?.addEventListener("click", () => {
        document.querySelectorAll('input[name="chartChoice"]').forEach(r => { r.checked = false; });
        clearChartPanel();
    });
    function setSlidersFromWeights01(w01) {
        if (!w01) return;

     
        CANON_ORDER.forEach((key) => {
            setSliderByKey(key, w01[key] ?? 0);
        });

        if (map.hasLayer(compositeLayer)) compositeLayer.redraw();
        updateLiveChangeUI();
    }

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
                ? topCur.map(d => `<span><strong>${escapeHtml(d.name)}</strong> (${prettyPct(d.cur)})</span>`).join(" | ")
                : "<span>none</span>"
            }</div>
        <div style="margin-top:4px;">
            ${baselineOk ? `
                <div>Biggest increases vs baseline: ${up.map(d => `<span><strong>${escapeHtml(d.name)}</strong> (${(d.delta >= 0 ? "+" : "") + (100 * d.delta).toFixed(1)}%)</span>`).join(" | ")
                }</div>
                <div>Biggest decreases vs baseline: ${down.map(d => `<span><strong>${escapeHtml(d.name)}</strong> (${(d.delta >= 0 ? "+" : "") + (100 * d.delta).toFixed(1)}%)</span>`).join(" | ")
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
                    label: "Delta weight (current - baseline)",
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
                                return `Delta ${(100 * v).toFixed(1)}%`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: "Delta weight" },
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
    const valueSources = {
        "Incidents Heatmap": new SafeTileLayer("./data/Incidents_Heatmap_VAL", { pane: "rasters" }),
        "Incidents Response Time": new SafeTileLayer("./data/Response_Time_VAL", { pane: "rasters" }),
        "Number of Trucks Dispatched to Incidents": new SafeTileLayer("./data/Trucks_VAL", { pane: "rasters" }),
        "Population Density": new SafeTileLayer("./data/Pop_Density_VAL", { pane: "rasters" }),
        "Fire Hydrants": new SafeTileLayer("./data/Fire_Hydrants_VAL", { pane: "rasters" }),
        "Land Use Risk": new SafeTileLayer("./data/Land_Use_VAL", { pane: "rasters" }),
        "Road Mobility": new SafeTileLayer("./data/Road_Mobility_VAL", { pane: "rasters" })
    };
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
            updateLiveChangeUI();
            return;
        }

        const w = getWeightsForSelection(method, selected);

        if (!w) {
            console.warn("No weights found for subset:", canonicalSubsetKey(selected), "method:", method);
            setAllSlidersZero();
            compositeLayer.redraw();
            updateLiveChangeUI();
            return;
        }

        
        Object.keys(colorSources).forEach(layerName => {
            setSliderByKey(layerName, w[layerName] ?? 0);
        });

        if (map.hasLayer(compositeLayer)) compositeLayer.redraw();

    }
    el("btnCRITIC")?.addEventListener("click", () => applyModelComposite("CRITIC"));
    el("btnRF")?.addEventListener("click", () => applyModelComposite("RF"));
    el("btnXGB")?.addEventListener("click", () => applyModelComposite("XGB"));
    el("btnSetBaseline")?.addEventListener("click", setBaselineToCurrent);
    el("btnResetBaseline")?.addEventListener("click", resetToBaseline);
    el("btnClearBaseline")?.addEventListener("click", clearBaseline);

    function clearRasters() {
        Object.values(layers).forEach(l => map.removeLayer(l));
        if (map.hasLayer(compositeLayer)) map.removeLayer(compositeLayer);
        activeRaster = null;
        setShow("modelPanel", false);
    }

    function applyRasterSelection(name) {
        clearRasters();
        activeRaster = name;

        const hideBox = el("chkHideLayers");
        if (hideBox) hideBox.checked = false;

        if (activeRaster === "__COMPOSITE__") {
            setShow("weights", true);
            setShow("modelPanel", true);
            compositeLayer.addTo(map);
            updateLiveChangeUI();

        } else {
            setShow("weights", false);
            setShow("modelPanel", false);

            if (layers[activeRaster]) layers[activeRaster].addTo(map);
        }
    }

    document.querySelectorAll('input[name="r"]').forEach((radio) => {
        radio.addEventListener("change", (e) => {
            if (e.target.checked) applyRasterSelection(e.target.value);
        });
    });

    const chkHideLayers = el("chkHideLayers");
    if (chkHideLayers) {
        chkHideLayers.addEventListener("change", (e) => {
            if (!e.target.checked) return;

            clearRasters();
            clearServiceAreaSelection();
            setShow("weights", false);
            document.querySelectorAll('input[name="r"]').forEach((r) => (r.checked = false));
        });
    }

    const SERVICE_AREA_CONFIG = {
        "21": {
            label: "21 Stations",
            url: "./data/Service%20Areas/Service_Area_21St.geojson"
        },
        "24": {
            label: "24 Stations",
            url: "./data/Service%20Areas/Service_Area_24St.geojson"
        },
        "27": {
            label: "27 Stations",
            url: "./data/Service%20Areas/Fire_Stations_Service_Coverage.geojson"
        }
    };

    function driveTimeColor(dt) {
        if (dt === "0 - 4") return "#006d6f";
        if (dt === "4 - 6") return "#2aa198";
        if (dt === "6 - 8") return "#b2dfdb";
        return "#ccc";
    }

    function normalizeDriveTime(value) {
        const text = String(value || "").trim().replace(/\s+/g, " ");
        if (/^0\s*-\s*4$/.test(text)) return "0 - 4";
        if (/^4\s*-\s*6$/.test(text)) return "4 - 6";
        if (/^6\s*-\s*8$/.test(text)) return "6 - 8";
        return text;
    }

    function serviceAreaStyle(feature) {
        const dt = normalizeDriveTime(feature.properties?.Drive_Time);
        return {
            color: "#444",
            weight: 1.2,
            fillColor: driveTimeColor(dt),
            fillOpacity: selectedCoverageRange === "ALL" || dt === selectedCoverageRange ? 0.55 : 0
        };
    }

    function sortCoverageFeatures(data) {
        const order = { "6 - 8": 0, "4 - 6": 1, "0 - 4": 2 };
        data.features.sort((a, b) => {
            const aDt = normalizeDriveTime(a.properties?.Drive_Time);
            const bDt = normalizeDriveTime(b.properties?.Drive_Time);
            return (order[aDt] ?? 0) - (order[bDt] ?? 0);
        });
        return data;
    }

    function loadServiceAreaLayer(key) {
        if (coverageLayers[key]) return Promise.resolve(coverageLayers[key]);

        const config = SERVICE_AREA_CONFIG[key];
        if (!config) return Promise.reject(new Error(`Unknown service area key: ${key}`));

        return fetch(config.url + "?v=" + Date.now())
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status} while loading ${config.label} service area`);
                return r.text();
            })
            .then((t) => {
                if (!t || t.trim().length === 0) throw new Error(`${config.label} service area GeoJSON is empty`);
                if (t.trim().startsWith("<")) throw new Error("HTML returned instead of GeoJSON");
                return sortCoverageFeatures(JSON.parse(t));
            })
            .then((data) => {
                coverageLayers[key] = L.geoJSON(data, {
                    pane: "coverage",
                    style: serviceAreaStyle
                });
                return coverageLayers[key];
            });
    }

    const legend = el("coverage-legend");

    function enforceStationZOrder() {
        const chkStations = el("chkStations");
        if (!chkStations || !chkStations.checked) return;
        if (stationsLayer && map.hasLayer(stationsLayer)) stationsLayer.bringToFront();
    }

    let selectedCoverageRange = "ALL";

    function removeActiveServiceArea() {
        if (!activeCoverageKey) return;
        const activeLayer = coverageLayers[activeCoverageKey];
        if (activeLayer && map.hasLayer(activeLayer)) map.removeLayer(activeLayer);
        activeCoverageKey = null;
    }

    function updateCoverageFilter() {
        const activeLayer = activeCoverageKey ? coverageLayers[activeCoverageKey] : null;
        if (!activeLayer) return;

        activeLayer.eachLayer(layer => {
            const dt = normalizeDriveTime(layer.feature?.properties?.Drive_Time);
            layer.setStyle({ fillOpacity: selectedCoverageRange === "ALL" || dt === selectedCoverageRange ? 0.55 : 0 });
        });
    }

    function applyServiceAreaSelection(key) {
        removeActiveServiceArea();
        activeCoverageKey = key;

        if (legend) legend.style.display = "block";
        if (el("coverageFilter")) el("coverageFilter").style.display = "grid";

        loadServiceAreaLayer(key)
            .then((layer) => {
                if (activeCoverageKey !== key) return;
                layer.addTo(map);
                updateCoverageFilter();
                enforceStationZOrder();
            })
            .catch((err) => console.error("Service area GeoJSON load failed:", err));
    }

    function clearServiceAreaSelection() {
        removeActiveServiceArea();
        document.querySelectorAll('input[name="serviceAreaChoice"]').forEach((r) => { r.checked = false; });
        selectedCoverageRange = "ALL";
        document.querySelectorAll('input[name="covRange"]').forEach((r) => { r.checked = r.value === "ALL"; });
        if (legend) legend.style.display = "none";
        if (el("coverageFilter")) el("coverageFilter").style.display = "none";
    }

    el("btnClearServiceArea")?.addEventListener("click", clearServiceAreaSelection);

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
                line-height: 1;
            ">
                &#128658;
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
        .catch((err) => console.error("Fire Stations load failed:", err));

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
    }, 2600);

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
        .catch((err) => console.error("City Boundary load failed:", err));
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

    const toggleUiButton = el("toggleUI");
    const layerPanel = el("layerToggle");

    if (toggleUiButton && layerPanel) {
        toggleUiButton.addEventListener("click", () => {
            layerPanel.classList.toggle("collapsed");
            toggleUiButton.setAttribute("aria-expanded", String(!layerPanel.classList.contains("collapsed")));
            setTimeout(() => window.map?.invalidateSize(true), 200);
        });
    }
    el("btnResetView")?.addEventListener("click", () => {

        map.setView([43.59, -79.64], 11);

        document.querySelectorAll('input[name="r"]').forEach(r => {
            r.checked = false;
        });

        const hideBox = el("chkHideLayers");
        if (hideBox) hideBox.checked = false;

        clearRasters();
        clearServiceAreaSelection();
        document.querySelectorAll('input[name="chartChoice"]').forEach(r => { r.checked = false; });
        clearChartPanel();

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

    el("btnFullscreen")?.addEventListener("click", () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    });
   
});



