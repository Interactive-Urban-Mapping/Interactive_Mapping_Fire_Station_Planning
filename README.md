# Interactive AI-GIS Multi-Criteria Mapping Tool for Fire Station Planning (Mississauga, Canada)

This repository contains the interactive web map developed for the study:

**GeoAI and Multi-criteria Evaluation for Risk-informed Urban Fire Station Planning**

## Overview
Fire station planning is often evaluated using response time and travel-time coverage (e.g., four-minute targets in urban areas). However, other factors that influence emergency service demand—such as historical incident patterns and population density—are not consistently integrated into planning analysis. This study proposes a multi-criteria AI-GIS evaluation framework that represents key criteria as raster indicators and supports scenario-based comparison for future station planning.

## Interface Preview

![Interactive web map UI showing composite raster visualization and baseline comparison controls](assets/ui_baseline_comparison.png)

## Data and Indicators
The web map visualizes raster indicators including:
- Travel time
- Historical incidents heatmap
- Incident response time
- Number of engines dispatched
- Population density
- Land-use risk
- Road network mobility
- Fire hydrant density

## Composite Mapping
Indicators are integrated into composite raster surfaces using different weighting approaches:
- **CRITIC**
- **RF**
- **XGB**
- **User-defined**

The tool also provides the ability to explore different combinations of indicators across weighting methods and compare results using a baseline option (e.g., setting a baseline configuration and visualizing changes relative to it).

The tool supports comparing station expansion scenarios by examining changes in travel-time coverage and shifts in priority areas under single-criterion vs. composite-criterion planning.

## Updating
The map can be updated by regenerating the raster indicators and composite layers following the study methodology (e.g., new data, revised weights, or additional scenarios).

## Supplementary Data
Spatial and incident datasets used in this study are publicly available through the City of Mississauga Open Data Portal:

https://data.mississauga.ca/
