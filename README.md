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

## Documentation

- **Manuel d'utilisation** : [docs/MANUEL.md](docs/MANUEL.md), aussi disponible dans l'application (bouton **Manuel**).
- **Démo guidée** : s'ouvre au premier lancement, puis avec le bouton **?**. Elle se termine par un essai complet sur le simulateur avec un programme d'exemple ([public/demo/copeau-demo.nc](public/demo/copeau-demo.nc)).

## Fonctions

- **Position** travail et machine, zéro par axe, retour X0 Y0.
- **Jog** : appui court = un pas, appui maintenu = mouvement continu jusqu'au relâchement. Clavier : flèches (X/Y), + / − ou PgUp/PgDn (Z). Le jog s'arrête si l'écran se déconnecte.
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

## Tests

```bash
npm test
```

Les tests utilisent le simulateur intégré (pièce virtuelle de 100 × 100 × 30 mm percée d'un trou Ø25, fraise Ø6).

## Structure

- `server/grbl.js` : protocole Grbl (envoi par comptage de caractères, état, jobs)
- `server/simulator.js` : Grbl simulé
- `server/probe.js` : routines de palpage
- `server/index.js` : serveur HTTP + WebSocket
- `public/js/shared/gcode.js` : interprète G-code partagé (visualiseur, estimation, reprise)
- `public/js/app.js`, `public/js/viewer.js` : interface
