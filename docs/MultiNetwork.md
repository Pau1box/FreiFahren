# Multi Network Support

## Overview

FreiFahren models exactly one transit system. Stations, lines and reports share a single flat
namespace, every response returns the whole network, and every inference rule reasons over that one
graph. That works as long as the one system is Berlin.

This document describes the **network**, a first class concept that lets one deployment serve
Berlin, Hamburg, Munich and any other city at the same time. The goal is that the only remaining
barrier to FreiFahren working in a city is whether enough people there report, and not code, data or
infrastructure.

## Why one deployment rather than one per city

Self hosting a city specific instance is technically possible today. It does not scale:

1. **Operational cost per city.** Each instance needs a server, a Postgres, a Telegram bot token, a
   security service, TLS, monitoring and someone who keeps it alive. That is a far higher bar than
   "enough people report".
2. **Client fragmentation.** A user moving from Berlin to Hamburg would need a different app and a
   different URL.
3. **Cold start.** A fresh instance has no history, so the predicted reports path has nothing to work
   with and the map stays empty, which is exactly when users leave.

One deployment with many networks gives one app, one API, one operations story, and history that
accumulates in one place.

## What a network is

A network is one self contained transit system. It is deliberately a **transit area rather than a
city**: Berlin's S1 runs to Oranienburg and the S7 to Potsdam, both outside the city limits, and
those stations belong to the same network as the rest of the line.

Every station, line and report belongs to exactly one network. That is what makes `S1` unambiguous:
it is only ever resolved inside one network, never across all of Germany.

`GET /v0/networks` lists them with the geography a client needs to position its map:

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

`serves` is the other cities the network reaches, generated from the stations it was built with. A
network is named after one city and often serves a dozen: the Rhine-Ruhr network is filed under
`duesseldorf` and stops in Dortmund, Essen, Duisburg and thirteen more. The clients search it
alongside the network's own name, so a rider in Dortmund finds their network without knowing whose
name it is under. It is always present and may be empty.

## Data model

`networks` is the new table. `stations`, `lines`, `line_stations` and `reports` all carry a
`network_id`.

### Line ids stay human readable

`S1`, `U6`, `M10` and `12` are real line designations in more than one German city, so `lines.id`
alone cannot be a primary key any more. Two options existed:

| Option                              | Effect                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| Prefixed ids (`berlin:S1`)          | Small schema diff, but every client and the line colours break |
| Composite key `(network_id, id)`    | Larger schema diff, wire format unchanged                  |

We chose the composite key. Since **every API response is scoped to a single network**, `S1` stays
unambiguous on the wire, the id remains what is printed on the vehicle, and no client has to change.

### Station ids stay globally unique

Station ids come from nationally unique sources: DS100 operating point codes for rail stations
(`S-BTGN`) and OSM node ids for everything else (`M-n1631224840`). Keeping them globally unique means
a report can name a station and its network follows from it. The data pipeline validator enforces
that property when a new city is added.

### Consistency is enforced by the database

A plain `station_id -> stations(id)` foreign key cannot detect that a Berlin station is being stored
under a Hamburg report, precisely because `stations.id` is globally unique. A unique key on
`stations(network_id, id)` gives the composite foreign keys a target:

| Attempt                                          | Result   |
| ------------------------------------------------ | -------- |
| Berlin station under a Hamburg report             | rejected |
| Berlin direction under a Hamburg report           | rejected |
| Berlin station placed on a Hamburg line           | rejected |
| Report naming a network that does not exist       | rejected |
| Consistent Hamburg report                         | accepted |
| Report without a line or direction                | accepted |

A null `line_id` or `direction_id` skips its own check (SQL `MATCH SIMPLE`), which is what we want: a
report without a line is valid, a report borrowing another network's line is not.

Cross network mixing is therefore structurally impossible rather than merely unlikely. See
`packages/hono-backend/tests/networks.test.ts`.

## API

Every change is additive. Calls that shipped before multi network support behave exactly as they did.

| Endpoint                       | Change                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| `GET /v0/networks`             | New. Lists networks with geography and status              |
| `GET /v0/transit/stations`     | Accepts `?network=`                                        |
| `GET /v0/transit/lines`        | Accepts `?network=`                                        |
| `GET /v0/reports`              | Accepts `?network=`                                        |
| `GET /v0/reports/:stationId`   | Accepts `?network=`                                        |
| `POST /v0/reports`             | Accepts `?network=`, rejects references from other networks |

The parameter is optional and falls back to the default network (`DEFAULT_NETWORK_ID`, currently
`berlin`), so clients released before this keep working. A test compares the response with and
without the parameter to keep that promise honest.

Two error cases are worth knowing:

- An unknown network answers **404** with `NETWORK_NOT_FOUND` rather than an empty map, so a client
  with a stale network id learns why nothing shows up.
- A report naming a station, direction or line the requested network does not contain answers **422**
  with the offending fields. This replaces a 500 that came from a foreign key violation. With more
  than one network that case stops being a typo and becomes the normal consequence of a client having
  the wrong city selected, which is a client error rather than a server fault.

## Inference and predictions

Report post processing guesses a station from history when a message only names a line. With one
network that was safe. With several it is not: a line only report from Hamburg would otherwise be
resolved against whichever Berlin station is busiest.

Everything the pipeline reasons over is now scoped to one network:

- the station and line graph is cached **per network** instead of once per process,
- report queries filter by network, and so do the historic rows the guess samples from,
- predictions are restricted to stations of the requested network.

A report the network cannot resolve is rejected rather than answered with a plausible station from
somewhere else.

### Predictions require an active network

Predicted reports exist so an established network never shows an empty map, on the assumption that
history says something about the present. A city added last week has no such history, so predicting
from it would not fill a gap, it would invent inspectors that were never reported, to the one person
we most need to keep.

A network therefore starts as `beta`, shows only real reports, and is promoted to `active` once its
coverage is real. This is keyed off the declared status rather than a row count, because "is there
enough coverage here to reason from" is an operational judgement rather than a magic number in the
code.

## Adding a city

A city is a YAML file in [`networks/`](../networks/README.md) plus the data generated from it:

```bash
python3 scripts/build_network.py --network zuerich
```

That queries OpenStreetMap, writes the seed data and the NLP synonym list where they are consumed,
and validates the result. No prompts, no manual copying, no code change. The full format and the two
decisions worth getting right are in [`networks/README.md`](../networks/README.md), the pipeline
itself in [`scripts/README.md`](../scripts/README.md).

### Hamburg

Hamburg ships as the second network, generated this way rather than written by hand. It is the proof
that the separation holds where it is hardest: Hamburg has an `S1`, `S2`, `S3`, `U1`, `U2`, `U3` and
`U4`, and so does Berlin. Both are served from one database, and a report naming a Berlin station
under `?network=hamburg` is rejected.

It starts as `beta`, so it shows only reports people actually made.

### Route planning

Routing was the last thing that only worked in Berlin, and not for a code reason: the itinerary
endpoint translates between our station ids and the routing engine's through `stationsMap.prod.json`,
and only Berlin had that file, written by hand.

`scripts/create_stations_map.py` now generates it per network, primarily from the same source as
everything else. German stations carry the nationwide DELFI station id (DHID) in the OpenStreetMap
tag `ref:IFOPT`, and that is exactly what the engine's DELFI feed is keyed by, so the mapping is an
identifier match rather than a name match. Where the tag is missing the transitous geocoder fills in
by name, confirmed by distance, and where the name finds nothing the same geocoder is asked by
coordinate instead. That third question is not a refinement of the second but a different one: the
feed indexes a stop under its own town, so a suburb stop cannot be found by any query naming the
city, however it is phrased.

No source is trusted on its own. Every id from OpenStreetMap is asked of the engine before it
ships, because the tag is a claim about the DELFI id that does not always survive contact with the
feed: about one Munich station in eight is not carried at station level, and Braunschweig reaches the
engine through a feed that does not use DHIDs at all. A station no source can place is left out,
and the backend answers "invalid station" rather than sending the engine an id it cannot resolve.
Across all 42 networks that maps 5932 of 5933 stations, 41 of them completely, and it is
why routing is no longer a Berlin feature. The details are in
[`scripts/README.md`](../scripts/README.md#routing-engine-ids).

One limitation stays. Translating the engine's answer back to our ids compares the numeric part of a
DHID, so it only works for networks whose feed uses DHIDs. Cities on a feed with opaque stop ids can
be routed, but their itineraries come back without our station ids attached, and therefore without
risk colours.

### Validation

`scripts/validate_network.py` runs in CI on every pull request touching network data. It fails the
build on a station outside the network's bounds, a line with fewer than two stations, an id longer
than its column, and, most importantly, the same station id claimed by two networks. The first build
of `hamburg.yaml` was caught by exactly that: its bounds were the city limits, but the S5 runs to
Stade in Lower Saxony.

## Time of day runs on the network's clock

Two parts of the report logic reason about the time of day: the threshold curve for predicted
reports (ramp up from 07:00, decline from 18:00) and the hour buckets `guessStation` compares
historic reports against. Both used to be read on the server's clock, which shifted the whole curve
by an hour or two on a UTC server. Both now go through `inNetworkTime` in
`packages/hono-backend/src/modules/reports/reports-service.ts`, which applies `networks.timezone`,
and fall back to UTC if a network ever carries an unusable zone: a curve an hour off is a smaller
failure than no reports at all.

The Go backend in `packages/backend`, which serves the clients today, follows the same rule: its
threshold curve and the hour and weekday buckets of its historic query both read the instant through
`data.NetworkLocation`, and the buckets are compared in the network's zone inside the SQL as well
(`EXTRACT(HOUR FROM timestamp AT TIME ZONE 'UTC' AT TIME ZONE $n)`), so both sides of the comparison
mean the same clock. It falls back to UTC on an unusable zone exactly as `inNetworkTime` does.

Every German network shares one timezone, so the difference shows up in two places today. Against a
UTC server the curve was simply shifted, and across the daylight saving change history was filed one
bucket off, because the same local hour maps to different UTC hours in summer and winter. The
structural point is the one that matters: nothing in the report logic reads the process timezone any
more.

## What each package does now

- **`packages/backend` (Go)** resolves `?network=` on every route, keys its caches, ETags and risk
  data by network, and embeds one data directory per city. A network without `segments.json` is
  served without risk colours rather than failing. Its copy of the generated data is written by
  `scripts/build_network.py`, not by hand, because the two copies had already drifted apart.
- **`packages/frontend`** reads `GET /v0/networks` at startup, picks the network from the stored
  choice, then from the user's position, then Berlin, and lets the user switch. Map center, bounds
  and zoom come from the network. Line colours and modes come from `GET /v0/lines/metadata`, so no
  client holds a table of Berlin's colours any more.
- **`packages/app` and `packages/mini_app`** follow the same contract, including the network
  dimension in every cache key and stored ETag.
- **`packages/nlp_service`** maps Telegram chats to networks through `FREIFAHREN_CHATS`
  (`<chat id>:<network id>`, comma separated), so one process serves several cities at once. It
  detects ring lines from the data rather than hardcoding S41.

## Judgement calls a maintainer may want to overrule

These are decisions, not defects. Each one is a single line of configuration or a small change away
from the opposite choice.

- **Night and reinforcement lines are kept.** Munich's data carries N17, N19, N20, N27 as well as E7
  and E20. They are real tram services that a passenger can be checked on, so they are lines like any
  other. A city that would rather not list them writes `tram: '^[0-9]+$'` in its mode rules.
- **A station without a name is dropped.** It cannot be reported, searched or labelled, so it would
  only ever be a gap in the data. It is rare: across all 42 networks it removes seven stations, six
  service platforms in Chemnitz and one in Rostock, and the build prints the count rather than
  dropping them quietly.
- **A designation OpenStreetMap gives is taken as it stands.** Halle therefore has a line `E` with
  two stops that runs out of the depot, and a line `3E/16` that is really two designations in one
  string. Both are what the map says, and inventing a rule that removes them would need a rule
  about what a line name may look like, which differs per city. What is filtered is only the
  unarguable: routes tagged as tourism, and a designation too long to be one. That last rule catches
  exactly two routes in Germany, and both deserve it: Karlsruhe's
  `E Einsatzwagen Betriebshof West <> Rheinhafen`, which is a depot working written out as a
  sentence, and Mainz's `Mini-Eisenbahn „Flotte-Lotte“`, a miniature railway in a park.
- **Icons exist for two modes.** `ubahn.svg` and `sbahn.svg` are Berlin's marks, drawn for subway,
  light rail and train in every city. Tram and unclassified lines get no icon rather than a borrowed
  one. Network neutral assets would be a design decision, not a code one.
- **Deep links carry no network.** `/station/:id` works because station ids are unique across
  networks, so the id identifies the city implicitly. Adding the network to the URL would make that
  explicit.
- **Hamburg and Munich keep Berlin's mode prefixes on their station ids.** Berlin's ids start with a
  letter per mode served, `SUM-` and so on, and it cannot stop, because those ids are in the database
  and in every installed app. Hamburg and Munich copied the habit because they were added first, and
  the other 39 networks have no prefix at all. Uniqueness does not need it, the id sources already
  guarantee that. This is the last moment it is free to change: neither city has reports yet, so
  dropping `modePrefixes` from their descriptions and rebuilding would cost two builds and would make
  Berlin the only city with the legacy scheme. Left as it is because it changes identifiers for
  tidiness, and identifiers are the thing this work is most careful with.

## Not covered

- The German language model is trained on Berlin messages. It is not retrained per city, and that is
  not planned here. In a new city expect more missed reports; because fuzzy matching is restricted to
  the network's own stations, the failure mode is a dropped report rather than a wrong one.
- Routing and risk colours need `stationsMap.prod.json` and `segments.json` per city. Both are
  optional and both backends serve a city without them, see `scripts/README.md` for how they are
  generated. The track in `segments.json` is found by routing over the fragments OpenStreetMap
  returns for a line, rather than by cutting a piece out of them, because a line arrives as dozens to
  hundreds of disconnected pieces in no particular order. A segment that comes out implausible for
  the distance between its two stations is dropped rather than drawn, so expect a few gaps per city
  where the OSM data is incomplete: an uncoloured gap is a smaller failure than a risk colour painted
  through the wrong streets.
- Nothing about what FreiFahren does or how reports are displayed changes, and a Berlin user should
  see the same map with the same stations under the same names. Two things there are worth naming
  rather than claiming a clean zero. The station order within 20 of Berlin's 47 lines is corrected,
  which changes the neighbours the distance endpoint walks, so a distance can come out a step or two
  different, along a route that is shorter on the ground. And `stationsMap.prod.json` was rebuilt, so
  24 Berlin stations that could not be routed to now can. Neither changes a station id, a line, or
  anything a report refers to.
- Some German systems are deliberately left out. A cluster of fewer than three OSM route relations is
  treated as a heritage or single line operation rather than an urban network, which leaves out the
  one line tramways at Woltersdorf, Schöneiche, Strausberg, Naumburg and Bad Schandau. Relations, not
  lines: a real line is mapped as at least one relation per direction, usually more where it branches.
  Saarbrücken is the case that shows the difference, and the reason the threshold is counted this way.
  It ends up with a single line, the Saarbahn, but that line arrives as enough relations to clear the
  threshold, and it is an urban light rail rather than a heritage tramway. Wuppertal's Schwebebahn
  is tagged `route=monorail`, a mode the pipeline does not carry, and the city's other lines are part
  of the Rhine-Ruhr network already. Each of these is a `networks/<id>.yaml` away if someone wants
  them.
- A network is a connected system, not a city. Bonn is served by Cologne's description, Mainz by its
  own and Wiesbaden through it, Heidelberg and Ludwigshafen by Mannheim's, Darmstadt and Offenbach by
  Frankfurt's, Heilbronn and Pforzheim by Karlsruhe's, and the whole Rhine-Ruhr from Duisburg to
  Dortmund by Düsseldorf's, which is why that one has 883 stations. Three descriptions were split off
  by hand for the opposite reason, because two systems sharing line numbers had been built into one:
  Gotha out of Erfurt, Halle out of Leipzig, Zwickau out of Chemnitz.
