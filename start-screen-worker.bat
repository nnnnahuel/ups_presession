@echo off
title UP.S Screen Worker
cd /d "%~dp0"

if "%DEVICE_ID%"=="" (
  echo Missing DEVICE_ID.
  echo Example:
  echo set DEVICE_ID=gym1-pc1
  exit /b 1
)

if "%LOCATION_ID%"=="" (
  echo Missing LOCATION_ID.
  echo Example:
  echo set LOCATION_ID=gym1
  exit /b 1
)

if "%SERVER_URL%"=="" (
  set SERVER_URL=https://equipo.up-s.ar
)

echo Starting distributed worker %DEVICE_ID% at %LOCATION_ID% against %SERVER_URL%
node worker.cjs
