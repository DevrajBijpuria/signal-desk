#!/usr/bin/env python3
"""Generate the Slash-palette map backgrounds (world + India).

Extends the rendering approach of maptoposter
(github.com/originalankur/maptoposter): same theme-JSON schema (see
scripts/map-themes/slash.json, derived from its midnight_blue theme) and the
same matplotlib poster pipeline — but rendering country/world boundaries from
Natural Earth GeoJSON instead of per-city OSMnx street graphs, which cannot
cover world or country scope. Fully keyless: Natural Earth over plain HTTPS.

This is a build-time asset generator, not part of the daily news pipeline.
Run it once (needs Python 3.10+ and matplotlib):

    py scripts/generate_map_backgrounds.py

Outputs (committed static images, referenced by the frontend):
    public/assets/bg-world.png
    public/assets/bg-india.png
"""

import json
import math
import os
import urllib.request

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".map-cache")
OUT = os.path.join(ROOT, "public", "assets")
THEME_PATH = os.path.join(ROOT, "scripts", "map-themes", "slash.json")

NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
WORLD_FILE = "ne_110m_admin_0_countries.geojson"
STATES_FILE = "ne_50m_admin_1_states_provinces.geojson"

# Major-city markers, hardcoded (lon, lat) — no geocoding, no network calls.
INDIA_CITIES = {
    "Delhi": (77.21, 28.61), "Mumbai": (72.88, 19.08), "Bengaluru": (77.59, 12.97),
    "Chennai": (80.27, 13.08), "Kolkata": (88.36, 22.57), "Hyderabad": (78.49, 17.39),
    "Pune": (73.86, 18.52), "Ahmedabad": (72.57, 23.02), "Jaipur": (75.79, 26.91),
    "Lucknow": (80.95, 26.85), "Srinagar": (74.80, 34.08), "Guwahati": (91.74, 26.14),
    "Kochi": (76.27, 9.93), "Bhopal": (77.41, 23.26), "Patna": (85.14, 25.59),
    "Chandigarh": (76.78, 30.73), "Bhubaneswar": (85.82, 20.30), "Nagpur": (79.09, 21.15),
    "Visakhapatnam": (83.30, 17.69),
}


def load_theme():
    with open(THEME_PATH, encoding="utf-8") as f:
        return json.load(f)


def fetch_geojson(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print(f"downloading {name} (one-time, cached in scripts/.map-cache) ...")
        req = urllib.request.Request(NE_BASE + name, headers={"User-Agent": "news-desk map background build"})
        with urllib.request.urlopen(req, timeout=180) as r, open(path, "wb") as f:
            f.write(r.read())
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def prop(feature, *names):
    p = feature.get("properties", {})
    for n in names:
        for key in (n, n.upper(), n.lower()):
            if key in p:
                return p[key]
    return None


def rings(geom):
    if geom is None:
        return
    if geom["type"] == "Polygon":
        yield from geom["coordinates"]
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield from poly


def draw_rings(ax, geom, color, lw, alpha=1.0, zorder=2):
    for ring in rings(geom):
        xs = [pt[0] for pt in ring]
        ys = [pt[1] for pt in ring]
        ax.plot(xs, ys, color=color, linewidth=lw, alpha=alpha,
                solid_capstyle="round", solid_joinstyle="round", zorder=zorder)


def save(fig, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    fig.savefig(path, dpi=100, transparent=True)
    plt.close(fig)
    print(f"wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)")


def render_world(theme, world):
    fig, ax = plt.subplots(figsize=(24, 11.4))
    fig.patch.set_alpha(0)
    ax.set_facecolor("none")

    # graticule — the ledger lines under the map
    for lon in range(-180, 181, 20):
        ax.plot([lon, lon], [-58, 84], color=theme["graticule"], linewidth=0.5, alpha=0.9, zorder=1)
    for lat in range(-40, 81, 20):
        ax.plot([-180, 180], [lat, lat], color=theme["graticule"], linewidth=0.5, alpha=0.9, zorder=1)

    for feature in world["features"]:
        if prop(feature, "continent") == "Antarctica":
            continue
        draw_rings(ax, feature["geometry"], theme["road_secondary"], 0.7, alpha=0.95)

    ax.set_xlim(-180, 180)
    ax.set_ylim(-58, 84)
    ax.set_aspect("auto")
    ax.axis("off")
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    save(fig, "bg-world.png")


def render_india(theme, world, states):
    fig, ax = plt.subplots(figsize=(13, 14))
    fig.patch.set_alpha(0)
    ax.set_facecolor("none")

    # graticule
    for lon in range(65, 100, 5):
        ax.plot([lon, lon], [5, 38], color=theme["graticule"], linewidth=0.5, alpha=0.9, zorder=1)
    for lat in range(5, 40, 5):
        ax.plot([65, 100], [lat, lat], color=theme["graticule"], linewidth=0.5, alpha=0.9, zorder=1)

    # state boundaries (inner texture), then the country outline on top
    if states is not None:
        for feature in states["features"]:
            if prop(feature, "adm0_a3") == "IND":
                draw_rings(ax, feature["geometry"], theme["road_tertiary"], 0.55, alpha=0.9, zorder=2)
    india = next((f for f in world["features"] if prop(feature := f, "admin") == "India"), None)
    if india is None:
        raise SystemExit("India polygon not found in Natural Earth data")
    draw_rings(ax, india["geometry"], theme["road_motorway"], 1.4, alpha=0.95, zorder=3)

    # city markers with a faint halo — the desk's watch points
    for _, (lon, lat) in INDIA_CITIES.items():
        ax.plot(lon, lat, marker="o", markersize=2.6, color=theme["city_dot"], alpha=0.95, zorder=4)
        ax.plot(lon, lat, marker="o", markersize=7, color=theme["city_dot"], alpha=0.18, zorder=4)

    ax.set_xlim(66.5, 98.5)
    ax.set_ylim(5.5, 37.8)
    # equirectangular aspect correction at India's mid-latitude
    ax.set_aspect(1.0 / math.cos(math.radians(22.0)))
    ax.axis("off")
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    save(fig, "bg-india.png")


def main():
    theme = load_theme()
    world = fetch_geojson(WORLD_FILE)
    try:
        states = fetch_geojson(STATES_FILE)
    except Exception as err:  # states are texture, not structure — degrade, don't fail
        print(f"state boundaries unavailable ({err}); rendering outline + cities only")
        states = None
    render_world(theme, world)
    render_india(theme, world, states)


if __name__ == "__main__":
    main()
