# Adapting the Tool to Other Cities

This tool was developed for Mississauga, Canada, but the workflow can be adapted to other municipalities using equivalent local data.

## Required Inputs

| Input | Format | Purpose |
|---|---|---|
| City boundary | GeoJSON | Defines the study area |
| Existing stations | Point GeoJSON | Represents the current network |
| Future/candidate stations | Point GeoJSON | Represents expansion scenarios |
| Travel-time polygons | GeoJSON | Shows service coverage |
| Raster indicators | XYZ PNG tiles | Displays spatial indicators |
| Composite rasters | XYZ PNG tiles | Displays composite risk surfaces |

## General Workflow

1. Prepare local spatial datasets.
2. Export vector layers as GeoJSON.
3. Normalize raster indicators to a 0–1 range.
4. Generate XYZ PNG tiles for raster layers.
5. Replace or add layers in the `data/` folder.
6. Update layer paths, labels, and legends in `app.js`.
7. Test layer alignment and map interaction.

## Notes

The tool supports planning-level scenario exploration. It is not designed for real-time dispatch or live routing.

If operational incident data cannot be shared, users can adapt the tool using processed raster indicators or local public datasets.
