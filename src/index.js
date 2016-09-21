'use strict';

var Protobuf = require('pbf'),
    VectorTile = require('vector-tile').VectorTile,
    L = require('leaflet'),
    corslite = require('corslite'),
    rbush = require('rbush'),
    extent = require('turf-extent'),
    inside = require('turf-inside'),
    polygon = require('turf-polygon'),
    point = require('turf-point');

module.exports = L.TileLayer.Underneath = L.TileLayer.extend({
    options: {
        layers: [],
        defaultRadius: 20,
        featureId: function(f) {
            return f.properties.osm_id;
        },
        lazy: true,
        zoomIn: 0,
        joinFeatures: false
    },

    initialize: function(tileUrl, options) {
        L.TileLayer.prototype.initialize.call(this, tileUrl, options);
        this._bush = rbush(this.options.rbushMaxEntries);
    },

    query: function(latLng, cb, context, options) {
        if (!this._map) return;

        options = options || {};
        var z = this._map.getZoom() + (options.zoomIn || this.options.zoomIn);

        var radius = options.radius || this.options.defaultRadius;
        radius *= this._map.getZoomScale(z);

        var p = this._map.project(latLng, z);

        if (this.options.lazy) {
            this._loadTiles(p, radius, L.bind(function(err) {
                if (err) {
                    return cb(err);
                }
                this._query(latLng, p, options, cb, context);
            }, this));
            return this;
        }

        this._query(p, radius, cb, context);
        return this;
    },

    _query: function(latLng, p, options, cb, context) {
        var sqDistToP = function(s) {
                var dx = (s[0] + s[2]) / 2 - p.x,
                    dy = (s[1] + s[3]) / 2 - p.y;
                return dx * dx + dy * dy;
            },
            radius = options.radius || this.options.defaultRadius,
            sqTol = radius * radius,
            search = this._bush.search([p.x - radius, p.y - radius, p.x + radius, p.y + radius]),
            results = [],
            i;

        if (options.onlyInside) {
            var pFeature = point([latLng.lng, latLng.lat]);
            search = search.filter(function(data) {
                var f = data[4];
                if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
                    return inside(pFeature, f);
                } else {
                    return true;
                }
            });
        }
        search.sort(function(a, b) { return sqDistToP(a) - sqDistToP(b); });

        for (i = 0; i < search.length; i++) {
            if (options.onlyInside || sqDistToP(search[i]) < sqTol) {
                results.push(search[i][4]);
            }
        }

        cb.call(context, null, results);
    },

    _loadTiles: function(p, radius, cb) {
        var se = p.add([radius, radius]),
            nw = p.subtract([radius, radius]),
            tileBounds = L.bounds(
                nw.divideBy(this.options.tileSize)._floor(),
                se.divideBy(this.options.tileSize)._floor());

        this._forceLoadTiles = true;
        this._addTilesFromCenterOut(tileBounds);
        this._forceLoadTiles = false;

        if (this._tilesToLoad) {
            this.once('load', function() { cb(); });
        } else {
            cb();
        }
    },

    _getZoomForUrl: function() {
        return L.TileLayer.prototype._getZoomForUrl.call(this) + this.options.zoomIn;
    },

    _getWrapTileNum: function () {
        var crs = this._map.options.crs,
            size = crs.getSize(this._map.getZoom() + this.options.zoomIn);
        return size.divideBy(this._getTileSize())._floor();
    },

    _addTile: function(tilePoint, fragment, cb) {
        var key = this._tileKey(tilePoint),
            tile = { datum: null, processed: false };

        if (!this._tiles[key] && (!this.options.lazy || this._forceLoadTiles)) {
            this._tiles[key] = tile;
            return this._loadTile(tile, tilePoint, cb);
        } else {
            this._tileLoaded();
            return cb && cb();
        }
    },

    _tileKey: function(tilePoint) {
        return tilePoint.x + ':' + tilePoint.y;
    },

    _loadTile: function(tile, tilePoint, cb) {
        var url,
            request;

        this._adjustTilePoint(tilePoint);
        url = this.getTileUrl(tilePoint);
        request = corslite(url, L.bind(function(err, data) {
            if (err) {
                this.fire('tileerror', {
                    tilePoint: tilePoint,
                    url: url,
                    error: err
                });
                this._tileLoaded();
                return cb && cb(err);
            }

            this._parseTile(tile, tilePoint, new Uint8Array(data.response));
            this._tileLoaded();
            return cb && cb();
        }, this), true);
        request.responseType = 'arraybuffer';
    },

    _reset: function() {
        L.TileLayer.prototype._reset.call(this);
        this._features = {};
        this._bush.clear();
        this.fire('featurescleared');
    },

    _parseTile: function(tile, tilePoint, data) {
        var x = tilePoint.x,
            y = tilePoint.y,
            z = tilePoint.z,
            vectorTile = new VectorTile(new Protobuf(data)),
            i,
            layerName,
            layer;

        tile.processed = true;

        for (i = 0; i < this.options.layers.length; i++) {
            layerName = this.options.layers[i];
            layer = vectorTile.layers[layerName];
            if (layer) {
                this._handleLayer(layer, x, y, z);
            }
        }
    },

    _handleLayer: function(layer, x, y, z) {
        var filter = this.options.filter,
            j,
            f,
            id,
            featureData,
            oldFeature;

        for (j = 0; j < layer.length; j++) {
            f = layer.feature(j);
            if (!filter || filter(f)) {
                id = this.options.featureId(f);
                featureData = null;
                if (!this._features[id]) {
                    featureData = this._featureToBush(f.toGeoJSON(x, y, z));
                } else if (this.options.joinFeatures) {
                    featureData = this._joinFeatures(id, f.toGeoJSON(x, y, z));
                    oldFeature = this._features[id];
                    if (featureData[0] !== oldFeature[0] ||
                        featureData[1] !== oldFeature[1] ||
                        featureData[2] !== oldFeature[2] ||
                        featureData[3] !== oldFeature[3]) {
                        this._bush.remove(oldFeature);
                    }
                }

                if (featureData) {
                    this._bush.insert(featureData);
                    this._features[id] = featureData;
                }
            }
        }
    },

    _featureToBush: function(geojson) {
        var z = this._map.getZoom() + this.options.zoomIn,
            bbox = extent(geojson),
            corners = [
                this._map.project([bbox[1], bbox[0]], z),
                this._map.project([bbox[3], bbox[2]], z)
            ],
            projBBox = L.bounds(corners);

        return [
            projBBox.min.x,
            projBBox.min.y,
            projBBox.max.x,
            projBBox.max.y, 
            geojson
        ];
    },

    _joinFeatures: function(id, add) {
        var featureData = this._features[id],
            f = featureData[4],
            fc = f.geometry.coordinates,
            ac = add.geometry.coordinates,
            atype = add.geometry.type,
            ftype = f.geometry.type;
        if ((atype === 'MultiPolygon' || atype === 'Polygon') && 
            (ftype === 'Polygon' || ftype === 'MultiPolygon')) {
            var apolys = atype === 'Polygon' ? [ac] : ac;
            var fpolys = ftype === 'Polygon' ? [fc] : fc;

            f.geometry = {
                type: 'MultiPolygon',
                coordinates: fpolys.concat(apolys)
            }
        } else if (atype === 'MultiPolygon' && ftype === 'MultiPolygon') {
            f.geometry.coordinates = fc.concat(ac);
        } else if (atype === 'Point' && ftype === 'Point') {
            return featureData;
        } else {
            throw 'Invalid join of geometry types ' +
                add.geometry.type + ' and ' +
                f.geometry.type;
        }

        return this._featureToBush(f);
    }
});

L.tileLayer.underneath = function(tileUrl, options) {
    return new L.TileLayer.Underneath(tileUrl, options);
};
