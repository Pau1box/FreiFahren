"""
Build every generated artefact for one network, then validate the result.

    python3 scripts/build_network.py --network hamburg

By default this writes the two files the backend seeds from and the synonym list the NLP service
uses. The two optional steps are off by default because they are slow or need extra dependencies.
Both are additive: a network without them is served without routing or without risk colours rather
than failing.

    --with-station-map   resolve routing engine ids, which is what gives a network routing
    --with-segments      download track geometry (needs geopandas and shapely)

Everything runs unattended, so this is what CI and a contributor adding a city both call. See
`networks/README.md`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List

from network_config import (
    GO_BACKEND_OPTIONAL_FILES,
    GO_BACKEND_REQUIRED_FILES,
    NetworkConfig,
    NetworkConfigError,
    load_network_config,
)

SCRIPT_DIR = Path(__file__).resolve().parent


def run_step(
    script: str, network_id: str, extra_args: List[str] | None = None, optional: bool = False
) -> bool:
    """
    Run one pipeline step in a subprocess. Returns whether it succeeded.

    Subprocesses rather than imports, because the steps have very different dependencies: the
    segments step needs geopandas, which most contributors will not have installed and do not need.

    An `optional` step that fails is reported and the build carries on, which is what this file and
    both READMEs have always promised: a network without route planning or without risk colours is
    served without that feature rather than not served at all. It used to end the run instead, and
    the damage was not the missing feature. The run ended after the station and line files were
    already written and before they were copied into the Go backend, so an afternoon of a busy
    Overpass left the two copies of the data disagreeing, which is exactly what the validator's
    byte comparison exists to catch.
    """
    command = [sys.executable, str(SCRIPT_DIR / script), "--network", network_id, *(extra_args or [])]
    print(f"\n=== {script} ===", flush=True)
    result = subprocess.run(command, cwd=SCRIPT_DIR)
    if result.returncode == 0:
        return True
    if not optional:
        raise SystemExit(f"[FAIL] {script} exited with code {result.returncode}")
    print(
        f"[WARN] {script} exited with code {result.returncode}. Carrying on without what it "
        f"produces. Rerun it on its own with --network {network_id} to add it later.",
        file=sys.stderr,
        flush=True,
    )
    return False


def drop_stale_station_map_entries(config: NetworkConfig) -> None:
    """Remove routing entries for stations the freshly built list no longer has.

    `stationsMap.prod.json` survives a rebuild on purpose: it is expensive to produce, one request
    per station, and the station map step is optional. That is only safe while every id in it still
    exists. When a rebuild drops stations, as excluding a heritage line from the Rhine-Ruhr network
    did, the leftover entries make the file fail validation, and the step that would have rewritten
    it is exactly the one a busy Overpass afternoon skips.

    Entries are dropped rather than the file, so the stations that remain keep their routing.
    """
    path = config.backend_seed_dir / "stationsMap.prod.json"
    stations_path = config.backend_seed_dir / "StationsList.json"
    if not (path.is_file() and stations_path.is_file()):
        return

    stations = json.loads(stations_path.read_text(encoding="utf-8"))
    mapping = json.loads(path.read_text(encoding="utf-8"))
    stale = [station_id for station_id in mapping if station_id not in stations]
    if not stale:
        return

    for station_id in stale:
        del mapping[station_id]
    with path.open("w", encoding="utf-8") as handle:
        json.dump(mapping, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(
        f"[INFO] Dropped {len(stale)} routing entry(s) for stations this build no longer has: "
        f"{sorted(stale)}",
        flush=True,
    )


def resolve_serves(config: NetworkConfig) -> List[str]:
    """
    The other cities this network reaches, from this run or from the last one that worked out.

    `create_network_reach.py` is optional, so a build where it did not run must not silently drop a
    list that was already correct: the cities a network serves change when the network does, not
    when Overpass has a bad afternoon. Same reasoning as `stationsMap.prod.json` surviving a
    rebuild, and the stale case is handled the same way, by the validator checking the result
    against the stations that exist now.
    """
    if config.reach_cache_path.is_file():
        return json.loads(config.reach_cache_path.read_text(encoding="utf-8"))

    previous = config.backend_seed_dir / "network.json"
    if previous.is_file():
        served = json.loads(previous.read_text(encoding="utf-8")).get("serves", [])
        if served:
            print(f"[INFO] Keeping the {len(served)} served city(s) of the previous build", flush=True)
        return served
    return []


def write_seed_metadata(config: NetworkConfig) -> None:
    """
    Write the `network.json` the backend seeds into the `networks` table.

    It exists so the backend never has to parse YAML: the network description stays the single source
    of truth, and this is its machine readable projection.

    Written after the stations, because a network with `bounds: auto` derives them from its station
    coordinates.
    """
    stations_path = config.backend_seed_dir / "StationsList.json"
    with stations_path.open(encoding="utf-8") as handle:
        stations = json.load(handle)

    bounds = config.resolve_bounds(stations)

    output_path = config.backend_seed_dir / "network.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(config.to_seed_metadata(bounds, resolve_serves(config)), handle, ensure_ascii=False, indent=4)
        handle.write("\n")
    print(f"[DONE] {output_path} written, bounds span {bounds.diagonal_km:.0f} km")


def sync_go_backend_data(config: NetworkConfig) -> None:
    """
    Copy the generated files into the Go backend's embed directory.

    The Go backend compiles its data in with `//go:embed`, which cannot read outside its own module,
    so the files have to exist twice. Copying here rather than by hand is what keeps the two copies
    identical: the Go copy of Berlin had silently missed `isCircular` because nothing enforced it.
    """
    target = config.go_backend_data_dir
    target.mkdir(parents=True, exist_ok=True)

    copied = []
    for name in GO_BACKEND_REQUIRED_FILES:
        source = config.backend_seed_dir / name
        if not source.exists():
            raise SystemExit(f"[FAIL] {source} is missing, cannot sync the Go backend data")
        shutil.copyfile(source, target / name)
        copied.append(name)

    for name in GO_BACKEND_OPTIONAL_FILES:
        source = config.backend_seed_dir / name
        if source.exists():
            shutil.copyfile(source, target / name)
            copied.append(name)

    print(f"[DONE] {target}: {', '.join(copied)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--network", required=True, help="Network id, i.e. the name of a file in networks/")
    parser.add_argument(
        "--with-station-map",
        action="store_true",
        help="Also map station ids to routing engine ids, which is what enables routing (slow)",
    )
    parser.add_argument(
        "--osm-station-map",
        action="store_true",
        help="With --with-station-map, use only OpenStreetMap's ref:IFOPT and skip the geocoder",
    )
    parser.add_argument(
        "--with-segments",
        action="store_true",
        help="Also download track geometry (slow, needs geopandas and shapely)",
    )
    args = parser.parse_args()

    try:
        config = load_network_config(args.network)
    except NetworkConfigError as error:
        raise SystemExit(f"[FAIL] {error}") from error

    print(f"Building '{config.id}' ({config.name}, status {config.status})")

    # Whatever a previous run left behind describes a different download. Removing it here is what
    # lets the later steps trust the cache without checking how old it is.
    shutil.rmtree(config.route_cache_path.parent, ignore_errors=True)

    run_step("create_stations_list.py", config.id)
    drop_stale_station_map_entries(config)
    run_step("create_lines_list.py", config.id)
    run_step("create_line_metadata.py", config.id)
    run_step("create_synonyms.py", config.id)
    # Before the metadata is written, because that is the file the result goes into. Optional: it
    # needs shapely, and a network without it is served without the extra search terms.
    run_step("create_network_reach.py", config.id, optional=True)
    write_seed_metadata(config)

    if args.with_station_map:
        run_step(
            "create_stations_map.py",
            config.id,
            ["--osm-only"] if args.osm_station_map else [],
            optional=True,
        )

    if args.with_segments:
        run_step("create_segments.py", config.id, optional=True)

    # After the optional steps, so that segments and the station map are copied along when they
    # were generated in this run.
    sync_go_backend_data(config)

    run_step("validate_network.py", config.id)
    print(f"\nDone. Review the files in {config.backend_seed_dir} before committing them.")


if __name__ == "__main__":
    main()
