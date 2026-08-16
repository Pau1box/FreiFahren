# Data pipeline

These scripts turn a network description in [`networks/`](../networks) into the data files the
backend and the NLP service ship with. If you want to add a city, read
[`networks/README.md`](../networks/README.md) first. This file documents the pipeline itself.

## Running it

```bash
pip install -r scripts/requirements.txt
python3 scripts/build_network.py --network hamburg
```

`build_network.py` is the only entry point you normally need. It runs the steps in order and
validates the result, without prompting for anything, so it works the same on a laptop and in CI.

Two steps are optional because they are slow. Both are additive: a network built without them is
served without routing or without risk colours rather than failing.

```bash
python3 scripts/build_network.py --network hamburg --with-station-map --with-segments
```

`--with-station-map` is what gives a network route planning. It is slow because it asks the routing
engine about one station at a time, see [Routing engine ids](#routing-engine-ids).

`create_network_reach.py` runs by default and is optional in the same sense: it works out which
other cities the network's stations lie in, so a rider in Dortmund can find the Rhine-Ruhr network
without knowing it is filed under Düsseldorf. It needs `shapely` and one more Overpass query, and a
build where it does not run keeps whatever the previous build worked out rather than dropping it,
see [What a network serves](#what-a-network-serves).

`--with-segments` needs the geospatial packages (`geopandas`, `shapely`, `pyogrio`, `pyproj`). They
are in `requirements.txt`, but if installing them fails on your platform you can skip that step: the
other outputs do not depend on it.

## The steps

| Script                    | Reads                            | Writes                                                       |
| ------------------------- | -------------------------------- | ------------------------------------------------------------ |
| `build_network.py`        | `networks/<id>.yaml`             | `network.json`, then runs everything below                     |
| `create_stations_list.py` | OpenStreetMap via Overpass       | `StationsList.json`                                            |
| `create_lines_list.py`    | `StationsList.json`              | `LinesList.json`                                               |
| `create_line_metadata.py` | the route cache, else Overpass   | `LineMetadata.json`                                            |
| `create_synonyms.py`      | `StationsList.json`              | `synonyms.json` for the NLP service                            |
| `create_network_reach.py` | `StationsList.json`, Overpass    | the `serves` list in `network.json` (optional)                 |
| `create_stations_map.py`  | `StationsList.json`, Overpass, transitous | `stationsMap.prod.json` (optional)                    |
| `create_segments.py`      | both lists, Overpass             | `segments.json` (optional)                                  |
| `validate_network.py`     | the generated files              | nothing, exits non zero on a problem                           |

The steps share four modules rather than a framework: `network_schema.py` holds what a network
description is, `network_config.py` reads and validates one, `overpass.py` talks to OpenStreetMap
with mirrors and backoff, and `track_graph.py` routes over track fragments for the segments.

Backend artefacts land in `packages/hono-backend/src/db/seed/networks/<id>/`, the synonym list in
`packages/nlp_service/core/data/networks/<id>/`. The scripts write them where they are consumed, so
there is no manual copying step.

That seed directory is the source of truth for generated data, and it holds one file more than the
Hono backend itself reads: `segments.json` is track geometry, and only the Go backend serves it. It
lives there anyway so that every generated file for a network sits in one place and
`sync_go_backend_data` has a single directory to copy from. Deleting it because "Hono does not use
it" would take the geometry out of the only place the pipeline writes it.

Every script also runs on its own with `--network <id>`, which is useful when only one output needs
regenerating.

### The route cache

`create_stations_list.py` writes the route relations it accepted, id and tags, to
`scripts/.build-cache/<id>/`, and the later steps read them from there rather than asking Overpass a
second time. The id is in there because `create_segments.py` fetches a relation's geometry by id.

That is not only about speed. The public mirrors do not all serve the same snapshot: asking twice
for the tram routes around Mannheim returned 49 relations one minute and 51 the next, and the two
missing ones shipped as lines with no mode at all, because the line list came from one answer and
the metadata from the other. One query cannot disagree with itself.

`build_network.py` deletes the cache before it starts, so what a step reads always belongs to the
run it is part of. Running `create_line_metadata.py` on its own finds no cache and queries Overpass,
which is correct: on its own it has nothing to stay consistent with. The directory is ignored by
git and can be deleted at any time.

The consistency it buys therefore reaches as far as one `build_network.py` run and no further.
Generating a city's track weeks later means `create_segments.py` asks again and can get a different
answer than the line list was built from, and a line that has since lost its route relation ends up
with no track. Frankfurt's `EEx` is the case in this repository: it has a mode, so a route relation
existed when its metadata was written, and none came back when its track was fetched. The script
says so rather than skipping quietly, `[WARN] No relation found for line EEx`, and rerunning it is
usually enough. If it is not, the line has genuinely gone from OpenStreetMap and belongs in the
line list no longer either.

## How stations are found

`create_stations_list.py` asks Overpass for the route relations of the configured modes inside the
configured area, follows them to their member nodes, and then follows the `stop_area` relations those
nodes belong to. That last hop is what connects a platform node to the station it belongs to.

Two steps then make the result usable:

- **Merging.** Platforms within `mergeRadiusMeters` become one station. OpenStreetMap models Berlin
  Hauptbahnhof as three separate stations; for our purpose it is one place, because being checked on
  one platform tells you something about the others.
- **Ids.** The id comes from the first tag in `idSources` that the node carries, falling back to the
  OSM node id. Ids must be unique **across all networks**, which `validate_network.py` enforces. See
  the note on `ref` in [`networks/README.md`](../networks/README.md).

## Line order

`create_lines_list.py` has no timetable, only station coordinates. It builds a minimum spanning tree
over the stations of a line and walks it end to end, which recovers travel order for a normal line
and merges the arms of a branching one. It is a heuristic: check the output of a new city, in
particular circular and branching lines.

## Routing engine ids

Route planning needs a second id per station: the one the routing engine knows it by. That mapping
is `stationsMap.prod.json`, and without it a network is served without routing. `create_stations_map.py`
builds it from three sources, in order, each answering what the one before it could not.

The first is OpenStreetMap. German stations often carry `ref:IFOPT`, the nationwide DELFI station id
(DHID), which is exactly what the engine's DELFI feed is keyed by, so this is an identifier match
rather than a name match, and one Overpass query covers a whole network. Its limit is coverage, and
that varies by federal state: 93% of Munich's stations carry the tag, 19% of Braunschweig's, 4% of
Berlin's.

The second is the transitous geocoder asked by name, one request per station, accepted only if the
hit is within 500 m of where we have the station.

The third is the same geocoder asked by coordinate, and it exists because the name query has a blind
spot that no amount of tuning fixes. The feed indexes a stop under the town it is in, so a stop in a
suburb is not reachable by any query naming the city, and the endpoint always answers with five hits
ranked by relevance, which in a dense area are five addresses. Reverse geocoding with `type=STOP`
asks the question the other way round and does not depend on the name matching at all. Measured on
the 158 stations the name query could not place: adding the city to the query solved 5 of them,
asking by coordinate solved 100, and restricting the result to stops took it to 156.

Every id from the first source is checked against the engine before it is kept, because the tag is a
claim about the DELFI id and not every claim survives contact with the feed. Two things go wrong
there, and both are why the check exists rather than being paranoia:

- About one Munich station in eight has a DHID the feed does not carry at station level.
- A whole region can be served from a feed that does not use DHIDs at all. Braunschweig arrives
  through `de-VBN`, whose stops are opaque numbers, so no IFOPT tag there can ever resolve. After ten
  failures in a row with nothing verified the step gives up on OpenStreetMap for that network.

A request that does not reach the engine at all is neither of those. It is not evidence about the id,
so it is not counted as one: after five in a row the step stops with an error rather than writing a
file whose entries were never checked, which would look exactly like a verified one and fail only
when someone asks it for a route.

What the check rejects falls through to the geocoder rather than being dropped, and a station no
source can place is left out of the file. The backend answers "invalid station" for it, which is a
better failure than a routing request that cannot work.

Measured across all 42 networks: **5932 of 5933 stations** mapped, 41 of them completely. The one
that is not is `Kollenbeyer Weg` in Halle, which the engine's feed does not carry.

## Track geometry

`create_segments.py` draws the track between each pair of neighbouring stations. What Overpass
returns for a line is not one line: ways are split at every junction, and a line's two directions
and its branches are separate relations, so the geometry arrives as dozens to hundreds of
disconnected fragments. The script therefore routes over those fragments instead of cutting a piece
out of one of them, which also picks the right prong of a fork for free, because the shortest way
from one station to the next is the way the train goes. Station order comes from `LinesList.json`
rather than from a position along that geometry, and everything is measured in the network's UTM
zone, since a "nearest point" computed in degrees is skewed by a third at German latitudes.

A segment whose track is implausibly long or short for the distance between its two stations is
dropped rather than drawn: the map colours these segments by risk, so one through the wrong streets
misinforms where a missing one only leaves a gap. Expect a handful of gaps per city where the OSM
relations themselves are incomplete, usually at the outer end of a line.

Measured over the 40 networks whose build logs are in hand: **9542 of 9856 segments, 96.8%**, and no
network below 90%. The 314 that are missing account for themselves. 138 were rejected as implausible,
158 had no continuous track between the two stations, and 18 are on lines OpenStreetMap returned no
route relation for at all.

`MIN_LENGTH_RATIO` sits at 0.7, and it is worth knowing how far the rejected segments are from it
before anyone lowers it to recover a few. Of the 102 rejected for a track that is too short, the
median had **0.40** of the track it needed and 46 had less than a third, the worst 0.01. Those are
not borderline cases but places where OpenStreetMap has no continuous track, which makes them the
same gap as "no track found", noticed one step earlier. Moving the threshold to 0.6 would return 20
of the 102 and draw misrouted track for some of the other 82. Coverage is limited by what is mapped,
not by this number.

## What a network serves

A network is named after one city and often serves a dozen. The network filed under `duesseldorf`
stops in Dortmund, Essen, Duisburg and thirteen more, and someone in Dortmund scrolling a list of
forty cities has no reason to guess that theirs is in there. `create_network_reach.py` works out
which municipalities contain at least one station of the built network and writes them into
`network.json` as `serves`, which the clients search alongside the network's own name.

The test is containment in the city's administrative boundary, not distance to the city centre.
Distance cannot answer it: Cologne's line 4 ends in Leverkusen at a stop 8 km from the Leverkusen
city centre, while the nearest station to the centre of Bottrop is 3.8 km away and is in Essen. So
the step asks Overpass for the boundaries of every place above 50 000 inhabitants in the network's
bounds and tests the stations against the polygons.

It is generated rather than declared because the claim goes stale otherwise. `discover_networks.py`
used to write the list into the YAML as a comment, computed from route midpoints before the network
was built, and by the time the forty two networks in this repo existed four of those comments were
wrong: the Leipzig description still claimed Halle, which had become its own network, and the
Rhine-Ruhr description claimed Wuppertal, Solingen and Remscheid, which it never reached.

A build where the step does not run keeps the list the previous build produced, for the same reason
`stationsMap.prod.json` survives a rebuild: the cities a network serves change when the network
does, not when Overpass has a bad afternoon.

## Validation

`validate_network.py` runs on every pull request that touches network data. It fails the build on:

- station or line ids longer than the database columns allow,
- a station outside the network's declared bounds,
- a line with fewer than two stations, or referring to a station that does not exist,
- the same station id used by two networks,
- a `stationsMap.prod.json` that maps an unknown station id or a value that is not an engine id.
  The file is optional, but once it exists the backend trusts it in both directions without looking
  at it, so a broken entry reaches either the engine or the client,
- a `network.json` describing a different network than its directory, or one whose `serves` list is
  malformed, unsorted or names the network's own city,
- a station with no entry in the network's `synonyms.json`. The station extractor resolves a fuzzy
  match only through that list, so a station missing from it is silently unrecognisable in a
  message: the report is stored with no station and nothing logs a failure. Berlin had 125 such
  stations before this branch.

It warns, without failing, about stations that are on no line, lines that do not list a station
claiming them, and two stations mapped to the same engine id, which makes the reverse translation
pick an arbitrary one of them.

## Overpass etiquette

Overpass is a free service run on donated hardware. The scripts identify themselves with a
`User-Agent`, which the public instance requires (it answers `406 Not Acceptable` without one). Build
a network once and commit the result rather than regenerating it in a loop.

`overpass.py` walks three mirrors and waits longer after each refusal, up to nine attempts with the
wait capped at two minutes. Build one city at a time: two builds in parallel compete for the same
donated capacity and both end up slower than they would have been in sequence.

The validator's continuity check is worth reading before widening a bounding box. Three networks so
far turned out to hold two systems that share their line numbers, Erfurt with Gotha, Leipzig with
Halle and Chemnitz with Zwickau, and each one showed up as a line jumping 30 km between neighbouring
stops.
