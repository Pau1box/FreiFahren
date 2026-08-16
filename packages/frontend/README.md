# FreiFahren

## Overview

This repository contains the frontend code for the FreiFahren web application. The frontend is responsible for displaying the live map of ticket inspector locations, as well as providing a user-friendly interface for interacting with the data. The frontend communicates with the backend API to fetch real-time data and updates the map accordingly.

## Getting Started

### Prerequisites

-   [Node.js](https://nodejs.org/en/)

### Installation

1. Clone the repository

    ```sh
    git clone https://github.com/brandesdavid/FreiFahren
    ```

2. Install NPM packages

    ```sh
    npm install
    ```

3. Set up enviromental variables

    ```sh
    REACT_APP_JAWG_ACCESS_TOKEN=YOUR_JAWG_ACCESS_TOKEN
    REACT_APP_API_URL=http://localhost:8080
    ```

    You can get a free access token from [Jawg](https://www.jawg.io/).

    The map view is not configured here. Center, bounds and zoom come from the network the user is
    on, served by `GET /v0/networks`, so switching city is a choice in the app rather than a rebuild.
    A city's geography is declared in its file under [`networks/`](../../networks/README.md).

4. Run the app
    ```sh
    npm start
    ```

## Markers and structure

To display the location on the map, inside the Map directory
are the markers. To display and organize the markers, `/components/Map/Markers/MarkerContainer.tsx` maintain, calculate and render multiple markers on the map.

1. `/Markers/Classes/LocationMarker/LocationMarker.tsx`, is called in `Map.tsx`. We use this marker to query for and display the current user's location
2. `/Markers/Classes/OpacityMarker/OpacityMarker.tsx` is called in `MarkerContainer.tsx`. They represent the unique user reports on inspectors and fade after a couple of minutes.

In hindsight, the Markers directory lays a foundation for other Markers with different features/
