"""
Build `LinesList.json` for one network, ordering each line's stations by travel order.

Run it through the pipeline rather than directly:

    python3 scripts/build_network.py --network hamburg

The line set is taken from the network's `StationsList.json`, so a network that discovers its lines
from OpenStreetMap (`lines: auto`) does not have to list them anywhere.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Dict, List, Set, Tuple

from geo import haversine
from network_config import NetworkConfig, load_network_config


def build_mst(
    nodes: List[str], coords: Dict[str, Dict[str, float]]
) -> Dict[str, List[str]]:
    """Build a minimum spanning tree (adjacency list) over the nodes keyed by distance."""
    # initialize
    mst_adj: Dict[str, List[str]] = {n: [] for n in nodes}
    unvisited: Set[str] = set(nodes)
    visited: Set[str] = set()
    # start from first node
    current = nodes[0]
    visited.add(current)
    unvisited.remove(current)
    # best distances to visited
    best: Dict[str, Tuple[float, str]] = {}
    for u in unvisited:
        best[u] = (haversine(coords[current], coords[u]), current)
    while unvisited:
        # find nearest unvisited node
        u_min, (dist, v_min) = min(best.items(), key=lambda item: item[1][0])
        # add edge
        mst_adj[v_min].append(u_min)
        mst_adj[u_min].append(v_min)
        # update sets
        visited.add(u_min)
        unvisited.remove(u_min)
        del best[u_min]
        # update best distances
        for u in unvisited:
            d = haversine(coords[u_min], coords[u])
            if d < best[u][0]:
                best[u] = (d, u_min)
    return mst_adj


def _walk_farthest(adj: Dict[str, List[str]], start: str) -> Tuple[str, Dict[str, str]]:
    """The node farthest from `start` in hop count, plus the parent map to walk back from it."""
    parents: Dict[str, str] = {start: start}
    queue = [start]
    farthest = start
    while queue:
        node = queue.pop(0)
        farthest = node
        for neighbour in adj[node]:
            if neighbour not in parents:
                parents[neighbour] = node
                queue.append(neighbour)
    return farthest, parents


def _trunk_path(adj: Dict[str, List[str]]) -> List[str]:
    """
    The longest path through the tree, which is the line's main route.

    Two searches: the node farthest from any start is one end of the longest path, and the node
    farthest from that one is the other end. Picking the longest path rather than an arbitrary leaf
    keeps the main route contiguous and pushes short spurs into the branch handling below.
    """
    start = next(iter(adj))
    one_end, _ = _walk_farthest(adj, start)
    other_end, parents = _walk_farthest(adj, one_end)

    path = [other_end]
    while parents[path[-1]] != path[-1]:
        path.append(parents[path[-1]])
    return path


def order_path(adj: Dict[str, List[str]]) -> List[str]:
    """
    Flatten a station tree into one travel order that contains every station exactly once.

    A line is not always a simple path. Munich's S2 splits beyond Dachau, and so does roughly every
    branched line outside Berlin. The tree is therefore linearised rather than walked: the longest
    path becomes the trunk, and every subtree hanging off it is ordered the same way and spliced in
    directly after the station it branches from.

    The result is a compromise, and worth stating plainly. Two neighbours in the list are usually
    neighbours on the track, but at the point where a branch rejoins the trunk they are not. That is
    unavoidable when a tree has to become a list, and it is far better than the previous behaviour,
    which split at the first branching station only and silently dropped every station beyond a
    second one.
    """
    if len(adj) <= 1:
        return list(adj)

    trunk = _trunk_path(adj)
    on_trunk = set(trunk)

    order: List[str] = []
    for node in trunk:
        order.append(node)
        for neighbour in adj[node]:
            if neighbour in on_trunk:
                continue
            branch = _collect_subtree(adj, neighbour, exclude=node)
            branch_adj = {n: [m for m in adj[n] if m in branch] for n in branch}
            order.extend(order_path(branch_adj))
    return order


def _collect_subtree(adj: Dict[str, List[str]], root: str, exclude: str) -> Set[str]:
    """Every node reachable from `root` without passing through `exclude`."""
    seen: Set[str] = set()
    stack = [root]
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        stack.extend(n for n in adj[node] if n != exclude and n not in seen)
    return seen


def build_line_order(stations: Dict[str, dict], line: str) -> List[str]:
    """
    Return the station IDs of one line in travel order.

    There is no timetable to read the order from, so it is inferred: a minimum spanning tree over the
    stations approximates the track, and that tree is then flattened into a list.
    """
    station_ids = [sid for sid, info in stations.items() if line in info["lines"]]
    if len(station_ids) <= 1:
        return station_ids

    coords = {sid: stations[sid]["coordinates"] for sid in station_ids}
    return order_path(build_mst(station_ids, coords))


def create_lines_list(stations: Dict[str, dict]) -> Dict[str, List[str]]:
    """Order every line that appears in the station data, skipping any that ended up empty."""
    lines = sorted({line for info in stations.values() for line in info["lines"]})
    ordered: Dict[str, List[str]] = {}
    for line in lines:
        order = build_line_order(stations, line)
        if order:
            ordered[line] = order
    return ordered


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", required=True, help="Network id, i.e. the name of a file in networks/")
    args = parser.parse_args()

    config: NetworkConfig = load_network_config(args.network)
    stations_path = config.backend_seed_dir / "StationsList.json"
    if not stations_path.is_file():
        raise SystemExit(f"{stations_path} is missing. Run create_stations_list.py first.")

    with stations_path.open(encoding="utf-8") as handle:
        stations = json.load(handle)

    lines_list = create_lines_list(stations)

    output_path = config.backend_seed_dir / "LinesList.json"
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(lines_list, handle, ensure_ascii=False, indent=4)
    print(f"[DONE] {output_path} written with {len(lines_list)} lines", file=sys.stderr)


if __name__ == "__main__":
    main()
