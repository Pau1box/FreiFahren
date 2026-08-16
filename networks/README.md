# Networks

A **network** is one self contained transit system that FreiFahren can serve. Every station, line and
report belongs to exactly one of them, which is what lets one deployment cover Berlin and Hamburg at
the same time even though both have a line called `S1`.

Each network is one YAML file in this directory. Adding a city means adding a file and committing the
data generated from it. See [`docs/MultiNetwork.md`](../docs/MultiNetwork.md) for the concept and the
data model behind it.

## Where the list of networks comes from

Most of them were not typed out. `scripts/discover_networks.py` asks OpenStreetMap for every subway,
light rail and tram route in a country and groups the ones that run near each other into systems:

```bash
python3 scripts/discover_networks.py --country DE          # list what it finds
python3 scripts/discover_networks.py --country DE --write   # create the missing files
```

It never overwrites an existing file, and it matches by position rather than by name, so the hand
written `munich.yaml` is recognised as Munich and not written again as `muenchen.yaml`. Ids follow
the city's own name transliterated, `koeln` and `nuernberg` rather than `cologne` and `nuremberg`;
`munich` is the one exception, written by hand before the rest and kept because an id appears in
stored links and in `?network=`.

A generated file is a starting point, not a finished one. Read it, check the modes, and build it.

## Adding your city

```bash
cp networks/hamburg.yaml networks/zuerich.yaml   # then edit it, see the fields below
pip install -r scripts/requirements.txt
python3 scripts/build_network.py --network zuerich
```

Zurich because every German network with a tram or an underground already has a file here. A city
outside Germany needs nothing extra: set `countryCode` and `timezone` and the pipeline is the same.

That writes everything the backend and the NLP service need, and validates it. Then:

1. **Look at the data.** Open `packages/hono-backend/src/db/seed/networks/zuerich/StationsList.json`
   and check the station count and a few names. Open `LinesList.json` and check that each line starts
   and ends where you expect. Line order is derived from coordinates rather than a timetable, so
   circular and branching lines are worth a second look.
2. **Try it.** `bun run db:migrate && bun run db:seed` in `packages/hono-backend`, then
   `curl 'localhost:3000/v0/transit/lines?network=zuerich'`.
3. **Open a pull request** with the YAML file and the generated data. Keep it to one city.

A new network starts as `beta`, meaning the map shows only reports people actually made. Once
coverage is real a maintainer promotes it to `active`, which enables predicted reports. See
[`docs/MultiNetwork.md`](../docs/MultiNetwork.md) for why.

## What a network covers

### Area or box

A network is scoped either by an administrative area (`osmArea`) or by a rectangle
(`boundingBox`). Exactly one of the two.

Prefer the area: it follows the real city limits, and it is exact. Use a box when no single boundary
contains the system. The Rhine and Ruhr network runs through a dozen cities, and there is no
administrative area that is all of it and nothing else.

A box is coarse, so boxes of neighbouring networks overlap. The build resolves that by giving each
line to the network whose centre its stops sit closest to, which is the same rule that told the two
systems apart to begin with. Without it Duesseldorf and Cologne would each pick up the other's trams,
and the same station would end up in two networks.

### A transit area, not a city

A network is a **transit area, not a city**. Berlin's S1 runs to Oranienburg and Hamburg's S5 to
Stade, well outside either city. Those stations belong to the network, so the `bounds` have to
include them. The validator will tell you if they do not.

Sometimes the area is a region rather than a city with suburbs. The network filed under
`duesseldorf` also stops in Dortmund, Essen, Duisburg and thirteen other cities, and someone in
Dortmund browsing a list of forty networks has no reason to guess that. So the build works out which
municipalities contain a station of the network and publishes them as `serves` in `network.json`,
which the clients search alongside the network's own name. There is nothing to declare for it: it is
generated from the stations by `create_network_reach.py`, which is what keeps it from going stale
when a network is split. It is optional in the same way segments are, so a build without shapely or
without Overpass produces a network that is served without the extra search terms.

## Fields

Everything not marked optional is required.

| Field                              | Meaning                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `id`                               | Lowercase, used in `?network=` and as a directory name                       |
| `name`                             | Shown to users                                                              |
| `countryCode`                      | ISO 3166-1 alpha-2                                                          |
| `timezone`                         | IANA name, e.g. `Europe/Berlin`                                             |
| `status`                           | `beta` (default) or `active`, see above                                     |
| `center`                           | Where a client's map opens                                                  |
| `bounds`                           | The area the network covers, including out of town termini                    |
| `source.osmArea`                   | Name of the OpenStreetMap administrative area to search. One of this or `boundingBox` |
| `source.adminLevel`                | Optional. Regex on the area's admin level, defaults to `^[4-6]$`             |
| `source.boundingBox`               | `southWest` and `northEast` corners to search instead of an area             |
| `source.modes`                     | Any of `subway`, `light_rail`, `tram`, `train`. A list, or a mapping to line rules |
| `source.lines`                     | `auto` (default) to discover them, or `include:` and `exclude:` with explicit lists |
| `stations.mergeRadiusMeters`       | Optional. Platforms closer than this become one station, defaults to 250     |
| `stations.idSources`               | Optional. OSM tags to take the station id from, first match wins             |
| `stations.modePrefixes`            | Optional, and a new network does not want it, see below                     |
| `stations.geocodePrefixLetters`    | Optional. Which prefix letters may appear in a geocoder query                 |
| `lineColors`                       | Optional. `default` plus `overrides`, used when drawing track geometry        |
| `lineColors.useFallbackPalette`    | Optional. Give lines with no colour in OpenStreetMap distinct ones, default `true` |

## Two decisions worth getting right

### Which modes

`train` pulls in every regional and long distance service passing through the area, which is usually
not what you want. Start with `subway`, `light_rail` and `tram`, look at the discovered lines, and
only add `train` if your S-Bahn is tagged that way. München, Nürnberg and most of southern Germany
are in that position.

When one mode carries both, restrict that mode alone. Written as a mapping, each mode is either
`auto` or a regex the route's `ref` has to match, and the filter runs on the Overpass server rather
than after the download:

```yaml
source:
    osmArea: München
    modes:
        subway: auto
        tram: auto
        # S-Bahn is tagged route=train here, which also matches every ICE and EC passing through.
        train: '^S[0-9]+$'
```

The pattern is matched by Overpass, which understands POSIX extended regular expressions and not
`\d`, `\w` or `\s`. Write `[0-9]` instead. Loading the description rejects the shorthand forms rather
than letting a rule that matches nothing through.

The list form (`modes: [subway, light_rail]`) still means `auto` for every mode listed. The separate
`source.lines` filter applies on top, across all modes, and suits a network that wants one explicit
list rather than a rule per mode, the way `berlin.yaml` does.

`source.lines` also takes an `exclude:` list, and it exists for one situation. Heritage and leisure
operations are dropped already, by the `usage=tourism` and `service=tourism` tags, which is how
Chemnitz's Parkeisenbahn stays out. Not every such operation carries the tag: the Bergische
Museumsbahn is mapped as an ordinary tram route and arrived as a line of the Rhine-Ruhr network,
six stops 24 km from anything else in it. `exclude:` names it and nothing more:

```yaml
source:
    lines:
        exclude:
            - BMB
```

It takes exact references rather than a pattern on purpose. A pattern would grow into a second line
filter that nobody reads, while a list of references has to justify each entry with a comment, and
a reference that no longer exists in OpenStreetMap is visible as one that stopped mattering.

### Where station ids come from

Station ids have to be unique **across every network**, because the backend stores them in one
namespace. Two sources guarantee that:

- `ref:ds100`, the operating point code, unique across Germany
- the OSM node id, used as a fallback, unique across the planet

A plain `ref` tag is **not** safe: it is only unique within one operator, so two cities can easily
produce the same id. Berlin uses it for historical reasons and cannot stop without changing ids that
are already in the database. Your city should not. `validate_network.py` fails the build if two
networks claim the same station id.

`stations.modePrefixes` puts a letter per served mode in front of the id, so that Berlin's
Friedrichstraße is `SUM-…`. Berlin needs it because those ids are already in the database, and
Hamburg and Munich carry it only because they were written first, in Berlin's image. **Leave it out.**
The two id sources above are already unique nationwide, so the prefix adds nothing to uniqueness, and
it costs: the letters have to be stripped again before a station name reaches a geocoder, which is
what `stations.geocodePrefixLetters` exists for. Of the 42 networks here, 39 have no prefix, and
those are the ones a new city should look like.

## Regenerating an existing network

Only Hamburg and any city added after it are reproducible from their description. Berlin's data
predates this pipeline, and `berlin.yaml` documents it rather than rebuilding it: OpenStreetMap moves,
so regenerating would change station ids that are already stored in reports and installed apps.
