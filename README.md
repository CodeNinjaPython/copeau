# Copeau

Interface web pour piloter une CNC sous **Grbl 1.1 / grblHAL**, inspirée de CNCjs. Pilote aussi les lasers Grbl et la découpeuse laser **Emblaser 2** (firmware Smoothieware).

## Démarrer

```bash
npm install
npm start            # http://localhost:8000
```

Choisissez le type de machine (CNC Grbl, Laser Grbl ou Emblaser 2), le port série (ou **Simulateur** pour essayer sans machine, ou **Réseau** pour une machine en Wi-Fi), puis **Connecter**.

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

## Documentation

- **Manuel d'utilisation** : [docs/MANUEL.md](docs/MANUEL.md), aussi disponible dans l'application (bouton **Manuel**).
- **Démo guidée** : s'ouvre au premier lancement, puis avec le bouton **?**. Elle se termine par un essai complet sur le simulateur avec un programme d'exemple ([public/demo/copeau-demo.nc](public/demo/copeau-demo.nc)).

## Fonctions

- **Position** travail et machine, zéro par axe, retour X0 Y0.
- **Jog** : appui = un pas, appui maintenu = le pas répété (1, 1, 1… ou 10, 10, 10…), arrêt immédiat au relâchement. Clavier : flèches (X/Y), + / − ou PgUp/PgDn (Z). Le jog s'arrête si l'écran se déconnecte.
- **Visualiseur 3D** du parcours d'outil avec suivi en temps réel : position de l'outil, partie usinée en orange, temps restant.
- **Simuler** avant de lancer : lecture animée de l'usinage avec enlèvement de matière, curseur, vitesse 1× à 100×.
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
- **Laser** (profils *Laser Grbl* et *Emblaser 2*) : puissance en direct et correction de puissance, tir de repérage (éteint tout seul après 60 s), cadre du programme, reprise laser éteint, vue colorée selon la puissance.
- **Gravure d'image** façon LaserGRBL : niveaux de gris, noir et blanc ou tramage, balayage aller-retour avec marge d'accélération.
- **Emblaser 2** : protocole Smoothieware (bannière, `M115`, `M999`, `fire`, `M220` / `M221`, arrêt par Ctrl-X), en USB ou en Wi-Fi (TCP, port 23 par défaut), simulateur dédié.

### Et LaserGRBL ?

LaserGRBL est une application Windows séparée, pour Grbl ; sa prise en charge de Smoothieware (Emblaser 2) est expérimentale. Copeau ne l'embarque pas : il reprend sa fonction principale (gravure d'image ligne à ligne) et exécute les fichiers G-code préparés dans LaserGRBL ou LightBurn. Détails dans le [manuel, section 18](docs/MANUEL.md#18-laser--emblaser-2-et-lasers-grbl).

## Tests

```bash
npm test
```

Les tests utilisent le simulateur intégré (pièce virtuelle de 100 × 100 × 30 mm percée d'un trou Ø25, fraise Ø6) et un simulateur Smoothieware écrit d'après le code source de Smoothieware, pour l'Emblaser 2. Ils ne remplacent pas un essai sur la vraie machine.

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

- `server/grbl.js` : protocole Grbl et Smoothieware (envoi par comptage de caractères, état, jobs, laser)
- `server/simulator.js` : Grbl et Smoothieware simulés
- `server/tcp.js` : connexion réseau (telnet)
- `server/probe.js` : routines de palpage
- `server/index.js` : serveur HTTP + WebSocket
- `public/js/shared/gcode.js` : interprète G-code partagé (visualiseur, estimation, reprise)
- `public/js/shared/profiles.js` : types de machine (CNC, laser Grbl, Emblaser 2)
- `public/js/shared/raster.js` : gravure d'image ligne à ligne
- `public/js/app.js`, `public/js/viewer.js` : interface
