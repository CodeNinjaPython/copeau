# Copeau

Interface web pour piloter une CNC sous **Grbl 1.1 / grblHAL**, inspirée de CNCjs.

## Démarrer

```bash
npm install
npm start            # http://localhost:8000
```

Choisissez le port série de la machine (ou **Simulateur Grbl** pour essayer sans machine), puis **Connecter**.

## Application Windows portable

Avec Node.js 20 ou plus récent, depuis Windows :

```powershell
npm install
npm run build:portable
```

Le fichier `dist/Copeau-Portable-0.1.0.exe` est autonome : il s'exécute sans installer Node.js. Placez-le dans un dossier accessible en écriture ; les macros et réglages sont enregistrés dans le dossier `data` à côté du `.exe`. Le port série reste directement géré par l'application.

Pour lancer la fenêtre de bureau en développement : `npm run desktop`. La commande `npm start` conserve le lancement du serveur web.

Pour piloter depuis une tablette ou un téléphone du réseau local :

```bash
HOST=0.0.0.0 npm start
```

Attention : n'importe qui sur ce réseau peut alors commander la machine.

## Application Linux

Lorsqu'une version est publiée sur les [releases GitHub](https://github.com/CodeNinjaPython/copeau/releases), deux formats sont préparés pour Linux **x86_64** avec glibc :

- **Debian, Ubuntu et dérivés** : téléchargez le fichier `.deb` et `install-linux.sh` dans le même dossier, puis lancez :

  ```bash
  sh install-linux.sh ./Copeau-0.1.0-amd64.deb
  ```

  Adaptez le nom du fichier à la version téléchargée. Le script utilise `apt` pour installer le paquet et ses dépendances.
- **AppImage** : sur les autres distributions, téléchargez le fichier `.AppImage` puis rendez-le exécutable :

  ```bash
  chmod +x Copeau-0.1.0-x86_64.AppImage
  ./Copeau-0.1.0-x86_64.AppImage
  ```

  Adaptez également le nom à la version téléchargée. L'AppImage nécessite un environnement graphique et FUSE ; `udevadm` doit être disponible pour détecter les ports série.

Les macros et réglages sont conservés dans le profil utilisateur Linux (`$XDG_CONFIG_HOME`, ou `~/.config` par défaut), indépendamment du paquet. Pour accéder à la CNC, votre utilisateur doit avoir les droits sur le port série : sur Debian et Ubuntu, ajoutez-le si nécessaire au groupe `dialout` avec `sudo usermod -aG dialout "$USER"`, puis déconnectez-vous et reconnectez-vous. Sur une autre distribution, vérifiez le groupe propriétaire du port avec `ls -l /dev/ttyUSB0` ou `ls -l /dev/ttyACM0`.

Pour construire les deux fichiers depuis une machine Linux x86_64 avec Node.js 22 ou plus récent :

```bash
npm ci
npm run build:linux
```

Les fichiers sont créés dans `dist/`. GitHub Actions les construit aussi pour les pull requests, les mises à jour de `main` et les lancements manuels ; ils sont téléchargeables dans les artefacts du workflow **Linux**.

Pour publier une version, fusionnez d'abord le changement de version dans `package.json` et `package-lock.json`, puis poussez le tag correspondant, par exemple pour la version `0.1.0` :

```bash
git fetch origin main
git tag v0.1.0 FETCH_HEAD
git push origin v0.1.0
```

Le workflow crée ou complète alors la release GitHub et y ajoute les deux paquets, le script d'installation et leurs sommes SHA-256. Pour vérifier ces sommes, téléchargez tous ces fichiers dans un même dossier et lancez `sha256sum -c SHA256SUMS-linux-x64.txt`.

## Documentation

- **Manuel d'utilisation** : [docs/MANUEL.md](docs/MANUEL.md), aussi disponible dans l'application (bouton **Manuel**).
- **Démo guidée** : s'ouvre au premier lancement, puis avec le bouton **?**. Elle se termine par un essai complet sur le simulateur avec un programme d'exemple ([public/demo/copeau-demo.nc](public/demo/copeau-demo.nc)).

## Fonctions

- **Espaces de travail** en haut, inspirés de Blender : CNC (console, reprise, palpage), Laser (gravure, console, zone) et Configuration (réglages, zone, macros, console). Chaque espace retrouve son dernier panneau ; le programme et les réglages restent partagés. Changer d'espace n'active pas le mode laser et n'envoie aucune commande à la machine.
- **Position** travail et machine, zéro par axe, retour X0 Y0.
- **Jog** : appui = un pas, appui maintenu = le pas répété (1, 1, 1… ou 10, 10, 10…), arrêt immédiat au relâchement. Clavier : flèches (X/Y), + / − ou PgUp/PgDn (Z). Le jog s'arrête si l'écran se déconnecte.
- **Visualiseur 3D** du parcours d'outil avec suivi en temps réel : position de l'outil, partie usinée en orange, temps restant.
- **Simuler** avant de lancer : lecture animée de l'usinage avec enlèvement de matière, curseur, vitesse 1× à 100×.
- **Gravure laser** : import SVG/image et génération raster avec surcourse facultative, profils machine (dont Emblaser 2), préréglages numérotés, calques couleur 00 à 07 avec passes, G-code LightBurn en M4, vérifications `$13` / `$30` / `$32` et des repères, extinction avant déplacements rapides et pause.
- **Placer** : glisser le parcours sur le plateau, l'origine X/Y est décalée d'autant.
- **Plateau et zone de travail** : rectangle (2 coins) ou cercle, vérification que le programme tient, parcours du contour.
- **Clic sur le plateau** pour y amener la tête.
- **Jobs** : glisser-déposer un fichier, durée estimée, temps restant, pause, arrêt propre (maintien d'avance puis reset, sans perte de position).
- **Erreur Grbl pendant un job** : le job se met en pause au lieu de continuer.
- **Changement d'outil (M6)** : le job attend la fin des mouvements, affiche l'outil demandé et propose de refaire le Z.
- **Reprise de job** à une ligne choisie (champ, curseur ou clic sur le parcours 3D) : modes restaurés, broche relancée, approche par le Z de sécurité.
- **Palpage** : Z (avec cale), coin XYZ (4 coins), centre de trou. **Sans sonde** : méthode de la feuille de papier guidée pas à pas.
- **⌂ Origine** : retour au zéro établi (montée de sécurité, X0 Y0, descente lente à Z0). Palpage rapide puis fin, origine posée avec `G10 L2`.
- **Corrections en direct** : avance, broche, rapides.
- **Macros** enregistrées dans `data/macros.json`.
- **Réglages Grbl ($$)** lisibles et modifiables avec leur description en français.
- **Plusieurs écrans** synchronisés sur la même machine.

## Tests

```bash
npm test
```

Les tests utilisent le simulateur intégré (pièce virtuelle de 100 × 100 × 30 mm percée d'un trou Ø25, fraise Ø6).

## Travailler à plusieurs

On ne pousse pas directement sur `main` : chaque changement passe par une branche et une pull request.

```bash
git switch main && git pull              # récupérer le travail de l'autre
git switch -c ma-fonction                # une branche par sujet
# ... modifications ...
npm test                                 # vérifier avant de pousser
git add -A && git commit -m "Ce qui change"
git push -u origin ma-fonction           # puis ouvrir la pull request sur GitHub
```

Les tests tournent automatiquement sur chaque pull request (GitHub Actions). On fusionne quand ils sont verts et que l'autre a relu. Après la fusion : `git switch main && git pull`.

## Structure

- `server/grbl.js` : protocole Grbl (envoi par comptage de caractères, état, jobs)
- `server/simulator.js` : Grbl simulé
- `server/probe.js` : routines de palpage
- `server/index.js` : serveur HTTP + WebSocket
- `public/js/shared/gcode.js` : interprète G-code partagé (visualiseur, estimation, reprise)
- `public/js/app.js`, `public/js/viewer.js` : interface
