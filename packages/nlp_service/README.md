# FreiFahren NLP Service Documentation

## Overview

This service provides Natural Language Processing (NLP) capabilities for the FreiFahren system. It processes messages about ticket inspectors, extracting relevant information through various natural language processing techniques.

One process serves any number of transit networks, one Telegram group per network. See [Networks](#networks) for what that does and does not cover.

### Components

1. **NLP Processing**: Extracts information about ticket inspectors from messages using NER and other NLP techniques.
2. **Telegram Integration**: Interfaces with Telegram to receive and process messages.
3. **API Layer**: Provides endpoints for health checks, error reporting, and data transmission.

### Project Structure

```
nlp_service/
├── config/             # Configuration settings and language rules
├── core/               # Core NLP processing logic
│   ├── NER/            # Named Entity Recognition components
│   ├── data/           # Data files for NLP processing
│   ├── extractors/     # Feature extraction modules
│   └── testing/        # Test utilities
├── services/           # External service integrations
│   ├── api_adapter.py  # Flask API implementation
│   └── telegram_adapter.py # Telegram bot integration
├── utils/              # Utility functions
│   ├── database.py     # Database connectivity
│   └── logger.py       # Logging configuration
├── main.py             # Application entry point
├── Dockerfile.nlp_service # Container definition
├── Pipfile             # Pipenv dependency management
└── requirements.txt    # Traditional pip requirements
```

## Setup

### Environment Variables

Create a `.env` file in the root directory with the following content:

```shell
BACKEND_URL=http://localhost:8080
FREIFAHREN_CHATS=-1001234:berlin,-1005678:hamburg
NLP_BOT_TOKEN=[YOUR_BOT_TOKEN]
REPORT_PASSWORD=[SECURE_PASSWORD]
SENTRY_DSN=[OPTIONAL_SENTRY_DSN]
MINI_APP_SERVER_URL=[YOUR_SERVER_URL]  # URL where your Mini App is hosted (defaults to BACKEND_URL if not set)
```

`FREIFAHREN_CHATS` maps every Telegram group the bot listens to onto the network its messages are
about: `<chat id>:<network id>`, comma separated, whitespace around entries ignored. The network ids
are the ones from `GET /v0/networks`. The service refuses to start when the variable is missing or
malformed, rather than listening to nothing or filing reports into the wrong city.

The older `FREIFAHREN_CHAT_ID` and `NETWORK_ID` are still read when `FREIFAHREN_CHATS` is unset, so
an existing single group deployment keeps working unchanged (`NETWORK_ID` defaults to `berlin`).

### Dependencies

You can install dependencies using either pipenv or pip:

#### Using Pipenv (recommended)

```shell
pipenv install
pipenv shell
```

#### Using Pip

```shell
pip3 install -r requirements.txt
```

### Running the Application

Run the application by executing:

```shell
python -m nlp_service.main
```
> NOTE: Make sure to be in the `packages/` directory, to execute the `nlp_service.main` module

This will start all components in a single process.

### Tests

From the `packages/` directory, with no backend and no database running:

```shell
python -m unittest nlp_service.core.testing.check_for_spam_test
python -m unittest nlp_service.core.testing.remove_direction_and_keyword_test
python -m unittest nlp_service.core.testing.chat_networks_test
python -m unittest nlp_service.core.testing.station_extractor_test
python -m unittest nlp_service.core.testing.general_accuracy_test
```

`general_accuracy_test` scores 344 real messages and prints a failure percentage rather than passing
or failing. It builds its network from the seed files in `packages/hono-backend/src/db/seed/networks`
(`core/testing/seed_networks.py`), which is the same data the backend serves, and skips itself when
they are not checked out.

`ner_performance_test.py` scores the NER model on its own and is run from `core/testing/`.

## How it Works

1. **Initialization**:
   - The main script sets up the environment, connects to Sentry (if configured), and initializes components.
   - It starts the Telegram bot in a separate thread and runs the Flask server in the main thread.

2. **NLP Processing**:
   - Messages are received through the Telegram bot.
   - The core NLP components (in the `core/` directory) process these messages to extract ticket inspector information.
   - Various extractors and NER models identify key entities such as locations, times, and transport details.

3. **API Layer**:
   - The Flask application provides endpoints for:
     - Inspector reports coming from the backend (`/report-inspector`)
     - The Telegram Mini App and the reports it submits (`/mini-app`, `/mini-app/report`, `/send-mini-app`)

4. **Data Management**:
   - Processed information is stored in a PostgreSQL database.
   - Communication with the backend service provides consolidated data access.

## Networks

A message is attributed to a network by the group it arrived in. Messages from any other chat are
ignored and logged once per chat: a line or station name means nothing without the network it
belongs to, so guessing one would file the report into the wrong city. The network then travels with
the message all the way to the report, which is posted as `?network=<id>`.

The same rule decides where the bot speaks. `/start` is answered in a private chat, which is how a
user opens the Mini App, but not in a group that is not mapped to a network. `/send-mini-app` only
posts into a configured group, so the bot cannot be made to write into every chat it happens to be
a member of.

### What is per network

- **Stations and lines.** Loaded from the backend as `?network=<id>` and cached per network, not once
  per process. Ids are only unique inside their network, so `S1` in Hamburg and `S1` in Berlin never
  meet.
- **Synonyms.** `core/data/networks/<network>/synonyms.json`, generated by
  `scripts/build_network.py` when a city is added.
- **Fuzzy matching.** Runs against the stations and synonyms of the message's network only, so a
  Hamburg message can never resolve to a Berlin station.
- **Ring lines.** Derived from the station coordinates rather than from a list of line names: a line
  whose two ends are close together compared to its own length runs in a circle. That gives Berlin's
  S41 and S42 and Hamburg's U3, with no city named in the code, and it also picks up Düsseldorf's
  tram 706, which is not a ring, see `detect_ring_lines`. A ring line's terminus says nothing
  about direction, so the direction is dropped; and a message that says "Ring" or "Ringbahn" without
  naming a line is attributed to the network's ring line. In a network without a ring, that rule
  simply never fires. When a network has several ring lines the lowest id is picked, which is right
  when they serve the same loop in opposite directions, as Berlin's do, and a guess otherwise.
- **The Telegram groups a report is announced in.** `/report-inspector` and `/mini-app/report` take
  an optional `network` field and answer `400` for a network with no configured group. Omitting it
  means `berlin`, matching the backend default in `docs/MultiNetworkContract.md`. A network with
  several groups gets the report in all of them, mirroring the reading side: the bot listens to
  every group of a network, so every one of them sees the reports that came in through the app.

### What is not per network

- **The NER model** (`core/NER/models/loss17`) is a German language spaCy model trained on Berlin
  messages. It has not been retrained per city, and it is not planned to be. It recognises where a
  station name sits in a German sentence, which transfers reasonably; it also carries Berlin station
  names in its training data, which does not. Expect it to miss station names in a new city more
  often than in Berlin. Fuzzy matching still constrains whatever it finds to the right network, so
  the failure mode is a missed report rather than a wrong one.
- **The language rules** are German. Direction keywords (`richtung`, `nach`, `bis`), the ring
  keywords, and the convention of writing `S 41` or `U 8` and prefixing a station with `S` or `U` are
  all German usage. They are harmless in another German city and would need work for a
  non German speaking one.

## Docker Deployment

The service can be containerized using the provided Dockerfile:

```shell
docker build -f Dockerfile.nlp_service -t freifahren-nlp-service .
docker run -p 6000:6000 --env-file .env freifahren-nlp-service
```

or go into the root directory and run:

```shell
docker compose up 
```

For more detailed setup instructions, see [here](../SETTING_UP.md).

## Logging

The system uses a custom logger that writes to both stdout and a file (`app.log`).
