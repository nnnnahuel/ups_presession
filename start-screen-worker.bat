@echo off
title UP.S Screen Worker
cd /d "%~dp0"

if "%APP_BASE_URL%"=="" (
  echo Missing APP_BASE_URL.
  echo Example:
  echo set APP_BASE_URL=https://equipo.up-s.ar
  exit /b 1
)

echo Starting screen worker against %APP_BASE_URL%
node worker.cjs
