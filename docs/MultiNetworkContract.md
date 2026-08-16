# Multi Network Contract

The one page every client and backend implements against. The reasoning behind it is in
[`MultiNetwork.md`](./MultiNetwork.md); this file is the agreement itself.

## Rule 1: every request is scoped to one network

Every endpoint that returns or accepts transit data takes an optional `network` query parameter:

```
GET /v0/stations?network=hamburg
GET /v0/lines?network=hamburg
GET /v0/basics/inspectors?network=hamburg
POST /v0/basics/inspectors?network=hamburg
```

Omitting it means `berlin`. That is what keeps every client released before this working, and it is
the only reason the default exists. **New client code always sends the parameter explicitly**, even
for Berlin, so that the default never becomes load bearing.

An unknown network is `404` with a body naming the endpoint that lists the valid ones:

```json
{ "message": "Unknown network 'atlantis'. Call GET /v0/networks for the list of available networks." }
```

Not an empty result: a client with a stale network id has to learn why its map is blank.

## Rule 2: ids are only unique inside their network

`S1` exists in Berlin, Hamburg and Munich, and they are different lines. A line id is meaningless
without the network it came from, and it is not enough on its own in any request, cache key or
comparison.

Station ids are the exception, and a deliberate one: they are globally unique, they are derived from
nationally unique sources (DS100 codes, OSM node ids), and `scripts/validate_network.py` fails the
build if two networks ever claim the same one. That is what lets `/station/:id` be a deep link
without a network in it. Relying on it anywhere else still buys nothing: every endpoint that takes a
station id also takes a network, and sending the wrong one gets a 422 rather than a wrong answer.

The practical consequence for clients: **the network id belongs in every cache key**. A cache keyed
on `['lines']` will show Berlin's lines on Hamburg's map after a switch.

## Rule 3: nothing about a city is derived from its names

A line's type comes from its metadata, never from its name. `startsWith('S')`, `startsWith('U')`,
"a bare number is a tram" and "M means Metrotram" are Berlin conventions, not facts. Munich's `S1`,
Karlsruhe's `S1` and Berlin's `S1` are three different modes of transport in three different colours.

Likewise station importance: it is derived from the data (how many lines serve a station), never from
a list of names.

## Endpoints

### `GET /v0/networks`

Lists every network the deployment serves. No parameters. This is the entry point: a client calls it
before anything else.

```json
[
    {
        "id": "berlin",
        "name": "Berlin",
        "countryCode": "DE",
        "timezone": "Europe/Berlin",
        "center": { "latitude": 52.5162, "longitude": 13.388 },
        "bounds": {
            "southWest": { "latitude": 52.23115511676795, "longitude": 12.8364646484805 },
            "northEast": { "latitude": 52.77063424239867, "longitude": 14.00044556529124 }
        },
        "status": "active",
        "serves": ["Potsdam"]
    }
]
```

`serves` lists the other cities the network reaches. It is always present, possibly empty, and
generated from the network's stations rather than declared. A network is named after one city and
often serves a dozen: the Rhine-Ruhr network is filed under `duesseldorf` and stops in Dortmund,
Essen and Duisburg. A client that lets a user search the network list must search `serves` too, and
say which city matched, or a rider in Dortmund is told that no network covers them.

`status` is `active` or `beta`. A `beta` network shows only reports people actually made; it never
serves predicted ones, because it has no history to predict from. Clients should label it so a user
understands why the map is emptier than they expected.

`center` and `bounds` are what a client positions and constrains its map with. No client hardcodes
geography.

### `GET /v0/lines/metadata`

The colour, mode and shape of every line in the network. Replaces the per city colour tables that
used to live in each client.

```json
{
    "S1": { "color": "#1a962b", "mode": "light_rail", "isCircular": false },
    "S41": { "color": "#007734", "mode": "light_rail", "isCircular": true }
}
```

`mode` is one of `subway`, `light_rail`, `tram`, `train` or `unknown`. A client groups, sorts and
picks icons by `mode`, never by the first letter of the line name.

`isCircular` marks a line that runs in a loop, such as Berlin's S41 and S42 or the Rhine-Neckar
line 5, which circles from Mannheim through Heidelberg and Weinheim back to Mannheim. A ring has no
terminus, so a report on one carries no meaningful direction. The field is always present: `false`
means "not a ring", never "unknown".

It comes from `roundtrip=yes` in OpenStreetMap rather than from the geometry, which is why Hamburg's
U3 is `false` even though its map looks like a loop: it runs a circle plus a branch out to
Wandsbek-Gartenstadt, so it does have termini, and OSM does not tag it as a roundtrip. Guessing from
the geometry instead would have flagged it, and it would also have flagged Düsseldorf's tram 706,
whose two ends merely happen to be close together.

- `color` is always a lowercase six digit hex colour. Never absent.
- `mode` is `subway`, `light_rail`, `tram`, `train` or `unknown`. `unknown` means OpenStreetMap has
  no route relation for the line; render it neutrally rather than guessing.

### Two backends, two path schemes

The paths in this document are the ones the Go backend in `packages/backend` serves, because that is
what every client talks to today.

The Hono backend in `packages/hono-backend` serves the same data under a different prefix, and always
has: `v0/transit/stations`, `v0/transit/lines`, `v0/transit/lines/metadata`, `v0/reports`. Only
`v0/networks` is spelled the same in both. That difference predates multi network support and is not
introduced here, but it is worth writing down, because reading this table while looking at the Hono
routes is otherwise confusing. Whoever finishes the migration has to reconcile the two, and until
then a client must point at one backend, not at both.

### Existing endpoints

Unchanged in shape, all now accepting `network`:

| Endpoint                             | Notes                                                     |
| ------------------------------------ | ---------------------------------------------------------- |
| `GET /v0/stations`                   | `{ stationId: { name, coordinates, lines } }`               |
| `GET /v0/stations/:id`               |                                                            |
| `GET /v0/stations/search`            |                                                            |
| `GET /v0/stations/:id/statistics`    |                                                            |
| `GET /v0/lines`                      | `{ lineId: [stationId] }`                                   |
| `GET /v0/lines/:lineName`            |                                                            |
| `GET /v0/lines/segments`             | GeoJSON, carries `line_color` per segment                   |
| `GET /v0/basics/inspectors`          | Reports                                                    |
| `POST /v0/basics/inspectors`         | Rejects references from another network with `422`          |
| `GET /v0/risk-prediction/segment-colors` | Deprecated upstream, kept for older clients                |
| `GET /v1/risk-prediction/segment-colors` | What the web frontend calls                                |
| `GET /v0/transit/distance`           |                                                            |
| `GET /v0/transit/itineraries`        |                                                            |

## What a client does on startup

1. `GET /v0/networks`.
2. Pick the network:
   1. the one the user last chose, if it still exists,
   2. otherwise the one whose `bounds` contain the user's location, if location is available and
      inside exactly one network,
   3. otherwise `berlin`.
3. Position the map from that network's `center` and `bounds`.
4. Fetch `/v0/lines/metadata` and use it for every colour and every grouping decision.
5. Include the network id in every request and in every cache key.

A user must be able to switch networks explicitly, and the choice has to survive a restart. A client
that offers a search over the list searches `serves` as well as `name`, and one that does not shows
the selected network's `serves` so a rider can tell that their city is covered. Automatic
selection by location is a convenience, never a cage: someone in Hamburg may well want to look at
Berlin.

## What a client must not do

- Hardcode coordinates, bounds or zoom limits for a city.
- Hardcode line colours, line names or station names.
- Infer a line's type from its name.
- Cache transit data without the network in the key.
- Assume a network has an underground, a tram, or both.
