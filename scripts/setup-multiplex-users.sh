#!/bin/sh
set -eu

# Debian/Ubuntu and Arch both provide getent, groupadd, useradd, and usermod.
# Usage: sudo ./scripts/setup-multiplex-users.sh agent01 [agent02 ... agent20]
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ "$#" -ge 1 ] && [ "$#" -le 20 ] || { echo "supply 1 to 20 agent user names" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required for no-follow credential provisioning" >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
helper="$script_dir/provision-multiplex-credential.py"
[ -f "$helper" ] && [ ! -L "$helper" ] || { echo "missing safe credential helper" >&2; exit 1; }
uid_min=$(awk '$1 == "UID_MIN" { print $2; exit }' /etc/login.defs 2>/dev/null || true)
uid_min=${uid_min:-1000}

getent group whatsapp-pi >/dev/null || groupadd --system whatsapp-pi
id whatsapp-router >/dev/null 2>&1 || useradd --system --home-dir /var/lib/whatsapp-pi-router --create-home --shell /usr/sbin/nologin --gid whatsapp-pi whatsapp-router
install -d -m 0700 -o whatsapp-router -g whatsapp-pi /var/lib/whatsapp-pi-router
install -d -m 0750 -o root -g whatsapp-pi /etc/whatsapp-pi-router

for user in "$@"; do
    case "$user" in
        ''|*[!A-Za-z0-9._-]*) echo "invalid agent user name: $user" >&2; exit 1 ;;
    esac
    [ "$user" != root ] && [ "$user" != whatsapp-router ] || { echo "refusing privileged/reserved user: $user" >&2; exit 1; }
    id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
    entry=$(getent passwd "$user")
    uid=$(printf '%s' "$entry" | cut -d: -f3)
    gid=$(printf '%s' "$entry" | cut -d: -f4)
    home=$(printf '%s' "$entry" | cut -d: -f6)
    [ "$uid" -ge "$uid_min" ] || { echo "refusing system/reserved UID for $user" >&2; exit 1; }
    case "$home" in
        /*) ;;
        *) echo "home for $user must be absolute" >&2; exit 1 ;;
    esac
    case "$home" in
        /|/root|/var|/var/lib|/var/lib/whatsapp-pi-router|/etc|/usr) echo "refusing non-dedicated home for $user: $home" >&2; exit 1 ;;
    esac
    hash=$(python3 "$helper" "$uid" "$gid" "$home")
    usermod -a -G whatsapp-pi "$user"
    credential="$home/.config/whatsapp-pi-multiplex/token"
    printf '%s tokenHash=%s credential=%s\n' "$user" "$hash" "$credential"
done

echo 'Copy config/router.example.json to /etc/whatsapp-pi-router/config.json, insert hashes/routes, chmod 0600, then install and enable the systemd unit.'
