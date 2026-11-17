#!/bin/bash
# Runs pg_upgrade 18 -> 19 inside one container that mounts the cluster volume.
# Prints "STEP <name> <milliseconds> <exit code>" per step; logs go to /tmp.
set -uo pipefail
MODE=${1:-copy}; JOBS=${2:-2}
OLD=/var/lib/postgresql/18/docker; NEW=/var/lib/postgresql/19/docker
B18=/usr/lib/postgresql/18/bin; B19=/usr/lib/postgresql/19/bin
cd /tmp
step() { local n=$1; shift; local s e rc; s=$(date +%s%N); "$@" > "/tmp/step.$n.log" 2>&1; rc=$?; e=$(date +%s%N)
  echo "STEP $n $(( (e - s) / 1000000 )) $rc"; if [ $rc -ne 0 ]; then echo "--- $n log"; tail -40 "/tmp/step.$n.log"; fi; return $rc; }
echo "SIZE old_mb $(du -sm $OLD | cut -f1)"
cp $OLD/pg_hba.conf /tmp/pg_hba.conf.old
step initdb $B19/initdb -D $NEW -U postgres || exit 1
step check $B19/pg_upgrade -b $B18 -B $B19 -d $OLD -D $NEW -U postgres --check || exit 1
step upgrade $B19/pg_upgrade -b $B18 -B $B19 -d $OLD -D $NEW -U postgres --$MODE -j $JOBS || exit 1
step carry_pg_hba cp /tmp/pg_hba.conf.old $NEW/pg_hba.conf
echo "SIZE new_mb $(du -sm $NEW | cut -f1)"
echo "--- upgrade log"; cat /tmp/step.upgrade.log
echo "--- check log"; cat /tmp/step.check.log
