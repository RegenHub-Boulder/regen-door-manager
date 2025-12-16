# RegenHub Member Manager

Member management tool for RegenHub that issues door codes via Home Assistant.

WIP: NFC card scanning.

## Install

This application is set up for use through Docker Compose.

1. Create `.env` (see `.env.example` for an example)
2. Run `docker-compose up --build` (`docker compose up --build` depending on operating system; you may need to run this twice as the first time sets up the database)
3. Navigate to `localhost/admin`