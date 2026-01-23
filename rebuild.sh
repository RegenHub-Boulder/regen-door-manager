#!/bin/bash
# Rebuild and start containers in detached mode, then follow logs
# Ctrl+C will stop following logs but won't kill the containers

sudo docker compose up --build -d && sudo docker compose logs -f
