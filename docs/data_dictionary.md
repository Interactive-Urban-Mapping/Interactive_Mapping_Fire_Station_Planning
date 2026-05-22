# Data Dictionary

This document summarizes the main spatial layers used in the interactive fire station planning web map.

| Layer | Type | Main Use | Description |
|---|---|---|---|
| Existing fire stations | Point GeoJSON | Scenario baseline | Current fire station locations used to represent the existing service network. |
| Future fire stations | Point GeoJSON | Expansion scenarios | Planned or candidate fire station locations used for Phase 01 and Phase 02 comparisons. |
| City boundary | Polygon GeoJSON | Study area | Boundary used to define the spatial extent of the analysis. |
| Travel time coverage | Polygon GeoJSON | Service coverage | Coverage polygons showing areas reachable within selected travel-time thresholds. |
| Historical incidents heatmap | Raster tiles | Demand indicator | Spatial concentration of historical fire and emergency incidents. |
| Incidents response time | Raster tiles | Operational burden | Spatial pattern of historical response-time performance. |
| Number of engines dispatched | Raster tiles | Incident scale | Indicator representing the number of engines dispatched to incidents. |
| Population density | Raster tiles | Exposure indicator | Spatial distribution of population density. |
| Land-use risk | Raster tiles | Life-safety risk | Risk surface derived from land-use categories and fuzzy reclassification. |
| Road network mobility | Raster tiles | Mobility | Indicator representing road class and mobility conditions relevant to emergency response. |
| Fire hydrant density | Raster tiles | Suppression support | Density of fire hydrants used to represent local suppression infrastructure. |
| CRITIC composite | Raster tiles | Composite risk | Composite raster generated using CRITIC weights. |
| RF composite | Raster tiles | Composite risk | Composite raster generated using RF-derived weights. |
| XGB composite | Raster tiles | Composite risk | Composite raster generated using XGB-derived weights. |
| Manual composite | Raster tiles / dynamic map layer | User-defined comparison | Composite surface generated or visualized based on user-selected indicator weights. |

## Notes

All raster indicators were normalized to a 0–1 range before visualization. Higher values generally represent higher demand, risk, exposure, or operational burden.

Some operational incident data used to generate processed raster indicators may not be redistributed because of data access restrictions. The repository therefore focuses on sharing the web-map code, processed visualization layers where permitted, and documentation for adapting the workflow to other municipalities.
