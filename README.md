# Copeau

Interface web pour piloter une CNC sous **Grbl 1.1 / grblHAL**, inspirée de CNCjs.

## Démarrer

```bash
npm install
npm start            # http://localhost:8000
```

Choisissez le port série de la machine (ou **Simulateur Grbl** pour essayer sans machine), puis **Connecter**.

Pour piloter depuis une tablette ou un téléphone du réseau local :

```bash
HOST=0.0.0.0 npm start
```

Attention : n'importe qui sur ce réseau peut alors commander la machine.

## Fonctions

- **Position** travail et machine, zéro par axe, retour X0 Y0.
- **Jog** : appui court = un pas, appui maintenu = mouvement continu jusqu'au relâchement. Clavier : flèches (X/Y), PgUp/PgDn (Z). Le jog s'arrête si l'écran se déconnecte.
- **Visualiseur 3D** du parcours d'outil : la partie usinée se colore en orange en direct.
- **Jobs** : glisser-déposer un fichier, durée estimée, temps restant, pause, arrêt propre (maintien d'avance puis reset, sans perte de position).
- **Erreur Grbl pendant un job** : le job se met en pause au lieu de continuer.
- **Changement d'outil (M6)** : le job attend la fin des mouvements, affiche l'outil demandé et propose de refaire le Z.
- **Reprise de job** à une ligne choisie (champ, curseur ou clic sur le parcours 3D) : modes restaurés, broche relancée, approche par le Z de sécurité.
- **Palpage** : Z (avec cale), coin XYZ (4 coins), centre de trou. Palpage rapide puis fin, origine posée avec `G10 L2`.
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
