#!/bin/bash
# Follow container logs
# Ctrl+C will stop following logs but won't kill the containers

sudo docker compose logs -f
