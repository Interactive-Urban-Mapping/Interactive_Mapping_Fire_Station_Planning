# Tile Generation Workflow

The interactive map uses pre-generated raster tiles to display spatial indicators and composite risk surfaces. Raster processing was completed outside the web map, and the final tiles were stored in the `data/` folder for direct use in Leaflet.

## Tile Specifications

```text
Input raster format: GeoTIFF
Web map projection: EPSG:3857 for standard Leaflet web maps
Output tile format: PNG
Tile scheme: XYZ
Folder structure: z/x/y.png
Example tile path: data/layer_name/{z}/{x}/{y}.png
Zoom levels: 9–16
NoData handling: transparent or masked background
Value range: normalized 0–1
Software: QGIS / GDAL / QGIS Generate XYZ Tiles
