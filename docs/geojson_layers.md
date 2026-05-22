# GeoJSON Layers

The interactive map uses GeoJSON files to display vector layers such as fire station locations, future station locations, municipal boundaries, and travel-time coverage polygons. These files are stored in the `data/` folder and loaded directly by Leaflet through `app.js`.

## GeoJSON Specifications

```text
Input format: GeoJSON
Geometry types: Point and Polygon
Coordinate system: EPSG:4326
Use in map: station markers, planned stations, boundaries, and coverage polygons
Main software: QGIS / ArcGIS Pro / Python
Storage location: data/
