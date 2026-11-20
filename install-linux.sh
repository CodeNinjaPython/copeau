#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Utilisation : sh %s chemin/vers/Copeau.deb\n' "$0" >&2
  exit 2
fi

case "$1" in
  *.deb) ;;
  *)
    printf 'Le fichier doit être un paquet .deb : %s\n' "$1" >&2
    exit 2
    ;;
esac

if [ ! -f "$1" ] || [ ! -r "$1" ]; then
  printf 'Paquet introuvable ou illisible : %s\n' "$1" >&2
  exit 2
fi

if ! command -v apt-get >/dev/null 2>&1; then
  printf 'apt-get est nécessaire ; ce script est destiné à Debian et Ubuntu.\n' >&2
  exit 1
fi

package=$(realpath -- "$1")
if [ "$(id -u)" -eq 0 ]; then
  exec apt-get install -- "$package"
fi

if ! command -v sudo >/dev/null 2>&1; then
  printf 'sudo est nécessaire pour installer le paquet sans privilèges root.\n' >&2
  exit 1
fi
exec sudo apt-get install -- "$package"
