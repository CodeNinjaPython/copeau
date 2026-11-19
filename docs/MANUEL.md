# Manuel d'utilisation de Copeau

Copeau pilote une fraiseuse CNC équipée d'une carte **Grbl 1.1** ou **grblHAL** depuis un navigateur web. Ce manuel explique comment l'installer, préparer une pièce, lancer un usinage et réagir en cas de problème.

> **Sécurité avant tout.** Copeau envoie des ordres de mouvement réels. Gardez toujours l'arrêt d'urgence de la machine à portée de main, portez des lunettes, et ne laissez jamais une machine usiner sans surveillance. Le bouton **Reset** de Copeau n'est pas un arrêt d'urgence : il dépend de l'ordinateur et du câble USB.

## Sommaire

1. [Installation et lancement](#1-installation-et-lancement)
2. [Découvrir l'écran](#2-découvrir-lécran)
3. [Se connecter à la machine](#3-se-connecter-à-la-machine)
4. [Prise d'origine et alarmes](#4-prise-dorigine-et-alarmes)
5. [Déplacer la tête](#5-déplacer-la-tête)
6. [Définir l'origine de la pièce (zéro)](#6-définir-lorigine-de-la-pièce-zéro)
7. [Palpage automatique](#7-palpage-automatique)
8. [Plateau et zone de travail](#8-plateau-et-zone-de-travail)
9. [Charger et vérifier un programme](#9-charger-et-vérifier-un-programme)
10. [Lancer, mettre en pause, arrêter](#10-lancer-mettre-en-pause-arrêter)
11. [Changement d'outil](#11-changement-doutil)
12. [Reprendre un usinage interrompu](#12-reprendre-un-usinage-interrompu)
13. [Corrections en direct](#13-corrections-en-direct)
14. [Console, macros et réglages](#14-console-macros-et-réglages)
15. [Utiliser une tablette ou plusieurs écrans](#15-utiliser-une-tablette-ou-plusieurs-écrans)
16. [Raccourcis clavier](#16-raccourcis-clavier)
17. [Dépannage](#17-dépannage)

---

## 1. Installation et lancement

**Prérequis :** un ordinateur (macOS, Windows ou Linux) avec [Node.js](https://nodejs.org) version 20 ou plus récente.

```bash
git clone https://github.com/CodeNinjaPython/copeau.git
cd copeau
npm install
npm start
```

Ouvrez ensuite **http://localhost:8000** dans un navigateur récent (Chrome, Edge, Firefox ou Safari).

Pour arrêter Copeau, faites `Ctrl+C` dans le terminal. Pour le relancer : `npm start`.

| Variable | Rôle | Exemple |
|---|---|---|
| `PORT` | Change le port web (8000 par défaut) | `PORT=8080 npm start` |
| `HOST` | Autorise l'accès depuis le réseau local | `HOST=0.0.0.0 npm start` |

### La démo guidée

Au premier lancement, une **démo guidée** présente chaque partie de l'écran. Elle se termine par un bouton **Essayer avec le simulateur** qui connecte une machine virtuelle et charge un programme d'exemple : vous pouvez tout tester sans risque. Le bouton **?** en haut à droite relance la démo à tout moment.

### Le simulateur

Dans la liste des ports, **Simulateur Grbl (sans machine)** remplace une vraie carte. Il réagit comme Grbl : alarme au démarrage, prise d'origine, jog, usinage, erreurs. Il contient une pièce virtuelle pour tester le palpage :

| Élément | Position (coordonnées machine) |
|---|---|
| Bloc de 100 × 100 × 30 mm | X −220 à −120, Y −200 à −100, dessus à Z −50 |
| Trou débouchant Ø 25 mm | Centre X −170, Y −150 |
| Outil monté | Fraise droite Ø 6 mm |

---

## 2. Découvrir l'écran

| Zone | Contenu |
|---|---|
| **Barre du haut** | Choix du port, connexion, état de la machine, boutons Déverrouiller, Origine, Reset, aide **?** |
| **Colonne de gauche** | Position de l'outil, zéros, déplacements (jog), corrections en direct |
| **Centre** | Vue 3D du parcours d'outil, barre du programme (ouvrir, démarrer, pause, arrêter, progression) |
| **Colonne de droite** | Onglets Console, Reprise, Palpage, Zone, Macros, Réglages |

Sur tablette ou téléphone, les colonnes s'empilent : la vue 3D en haut, puis les commandes.

### Le badge d'état

| Badge | Signification |
|---|---|
| **Prêt** (vert) | La machine attend un ordre |
| **Usinage** / **Jog** / **Origine** (bleu) | Un mouvement est en cours |
| **Pause** (jaune) | Mouvement suspendu (pause ou `M0` dans le programme) |
| **Alarme** (rouge clignotant) | La machine est bloquée, voir [section 4](#4-prise-dorigine-et-alarmes) |

---

## 3. Se connecter à la machine

1. Branchez la carte en USB et allumez l'alimentation de la machine.
2. Cliquez sur **↻** pour rafraîchir la liste des ports.
3. Choisissez le port (sur Mac il ressemble à `/dev/cu.usbserial-…` ou `/dev/cu.usbmodem…`, sur Windows à `COM3`).
4. Laissez la vitesse à **115200** (valeur standard de Grbl), sauf si votre carte est réglée autrement.
5. Cliquez sur **Connecter**.

Copeau attend le message d'accueil de la carte, puis lit ses réglages. La console affiche `Connecté : Grbl 1.1h …`. Si rien ne se passe après quelques secondes, voir [Dépannage](#17-dépannage).

---

## 4. Prise d'origine et alarmes

Sur une machine équipée de fins de course, Grbl démarre souvent en **Alarme** : il ne sait pas encore où se trouve la tête.

- **Origine** (`$H`) : la machine cherche ses fins de course et connaît ensuite sa position exacte. C'est la méthode à privilégier.
- **Déverrouiller** (`$X`) : lève l'alarme sans prise d'origine. À n'utiliser que si vous êtes sûr de la position (pas de fins de course, ou la machine n'a pas bougé).

Une barre rouge sous le haut de l'écran explique l'alarme en cours. Alarmes fréquentes :

| Alarme | Cause | Que faire |
|---|---|---|
| 1 | Fin de course touché pendant un mouvement | Dégager à la main ou en jog après `$X`, puis refaire l'origine |
| 2 | Mouvement demandé hors des limites logicielles | Vérifier le zéro et la taille du programme |
| 3 | Reset pendant un mouvement | Refaire l'origine : la position est perdue |
| 4 | La sonde touchait déjà avant le palpage | Vérifier la pince et la cale, puis `$X` |
| 5 | Palpage sans contact dans la course prévue | Rapprocher l'outil ou augmenter la course, puis `$X` |
| 9 | Fin de course introuvable pendant l'origine | Vérifier câblage et réglages `$22`/`$23` |

---

## 5. Déplacer la tête

### Les flèches à l'écran

- **Appui court** : un pas de la taille choisie (0.01, 0.1, 1, 10 ou 50 mm).
- **Appui maintenu** : mouvement continu tant que vous gardez le doigt ou le clic. La tête s'arrête au relâchement.
- **■** : arrêt immédiat du déplacement.
- Les diagonales déplacent X et Y en même temps.

**Vitesse jog** règle l'avance des déplacements en mm/min.

### Au clavier

| Touche | Mouvement |
|---|---|
| ← → | X− / X+ |
| ↑ ↓ | Y+ / Y− |
| Page ↑ / Page ↓ | Z+ / Z− |
| Échap | Arrête tout déplacement |

Même règle : appui court = un pas, appui maintenu = continu. Les flèches ne déplacent pas la machine quand vous tapez dans un champ de saisie.

### En cliquant sur le plateau

Cliquez à un endroit de la vue 3D : une cible verte apparaît avec une bulle **Aller ici**. La case **Monter d'abord à Z…** remonte l'outil à la hauteur de survol avant de traverser, pour ne pas frotter la pièce. Le point visé est sur le plan Z0 du repère de travail. Si un plateau est défini, un clic en dehors est refusé.

> **Sécurités du déplacement.** Tous les déplacements passent par le jog de Grbl : ils s'arrêtent avec Échap ou ■. Si la page se ferme ou perd la connexion pendant un jog continu, Copeau l'arrête. Avec les limites logicielles actives (`$20=1`), le jog continu s'arrête 0,5 mm avant la limite.

---

## 6. Définir l'origine de la pièce (zéro)

Le **zéro** (ou origine travail) est le point de la pièce qui correspond à X0 Y0 Z0 dans le programme. Votre logiciel de FAO indique où il l'a placé (souvent le coin avant gauche, dessus de la pièce).

Les grands chiffres affichent la **position travail**. La petite ligne `M …` dessous est la **position machine**, qui ne change pas quand on refait le zéro.

### Mettre un axe à zéro

1. Amenez l'outil exactement sur le point voulu (jog en petits pas, ou palpage).
2. Cliquez sur **X = 0**, **Y = 0** ou **Z = 0**. Les boutons **Zéro XYZ** et **Zéro XY** font plusieurs axes d'un coup.

### Donner une valeur précise

Cliquez sur le chiffre d'un axe : il devient un champ. Tapez la valeur que la position actuelle doit avoir, puis **Entrée** (Échap pour annuler).

*Exemple :* l'outil touche le dessus d'une cale de 20 mm posée sur la pièce. Tapez `20` dans Z : le Z0 se retrouve sur le dessus de la pièce.

**→ X0 Y0** ramène l'outil au-dessus de l'origine (à la hauteur actuelle : remontez d'abord si besoin).

Le zéro est enregistré dans la carte (repère `G54` par défaut) et survit à une coupure.

---

## 7. Palpage automatique

Le palpage utilise une **sonde** : une pince crocodile sur l'outil et une plaque ou la pièce elle-même reliée à l'entrée sonde de la carte. Le contact électrique arrête le mouvement et Copeau en déduit l'origine.

**Avant chaque palpage :**

1. Branchez la pince sur l'outil.
2. Testez la sonde : touchez la plaque avec la pince, l'état de la sonde doit changer (`Pn:P` dans `?`, ou voyant de la carte).
3. Cochez **La sonde est branchée et testée**.

Chaque palpage se fait en deux temps : approche **rapide**, recul, puis approche **fine** pour la précision. L'origine est calculée à partir du point de contact exact mesuré par Grbl.

### Palpage Z

Pose Z0 sur le dessus de la pièce.

1. Posez la cale sous l'outil (ou rien si l'outil touche directement une pièce conductrice).
2. Placez l'outil 5 à 20 mm au-dessus.
3. Indiquez l'**épaisseur de la cale** (0 sans cale), puis **Lancer le palpage**.

### Coin XYZ

Pose X0 Y0 Z0 sur un coin de la pièce.

1. Choisissez le coin : arrière gauche, arrière droit, avant gauche ou avant droit.
2. Placez l'outil **au-dessus de la pièce**, à environ la **distance outil / bords** (10 mm par défaut) des deux côtés du coin.
3. Renseignez le **diamètre de l'outil** (indispensable pour X et Y), l'épaisseur de cale en Z, et l'épaisseur de la paroi de cale en XY si vous utilisez une cale d'angle.
4. Lancez. Copeau palpe le dessus, descend sur le côté de la pièce, palpe X, puis Y, remonte et se place au-dessus du coin.

### Centre de trou

Pose X0 Y0 au centre d'un alésage.

1. Descendez l'outil **dans le trou**, sous le bord, à peu près au centre.
2. Indiquez le diamètre de l'outil et le rayon maximal du trou.
3. Lancez. Copeau palpe les deux côtés en X, se centre, fait de même en Y, puis repalpe X pour la précision. Le résultat affiche le diamètre mesuré.

Le bouton **Palper Z** de la fenêtre de changement d'outil lance un palpage Z avec les derniers réglages utilisés.

---

## 8. Plateau et zone de travail

L'onglet **Zone** décrit deux formes, dessinées dans la vue 3D :

- **Plateau** (gris) : la surface physique de la machine. Toujours un rectangle.
- **Zone de travail** (jaune) : l'endroit où se trouve la pièce. Rectangle ou cercle.

### Trois façons de les définir

1. **Capturer** : amenez l'outil sur un coin, cliquez **Capturer** du *Coin 1* ; faites de même pour le coin opposé (*Coin 2*). Pour un cercle : capturez le **Centre**, puis amenez l'outil sur le bord et cliquez **Point du bord**.
2. **Tracer sur la vue** : la vue passe en dessus. Cliquez un premier coin (ou le centre), un aperçu vert suit la souris, cliquez le coin opposé (ou un point du bord). Échap annule.
3. **Saisir** les valeurs en coordonnées travail (celles des grands chiffres).

Raccourcis : **Depuis $130 / $131** crée le plateau à partir de la course de la machine (valable après une prise d'origine) ; **Depuis le programme** crée une zone au cadre du programme chargé.

Les formes sont mémorisées en **coordonnées machine** : elles restent au même endroit physique quand vous changez le zéro. Elles sont partagées entre tous les écrans et conservées après redémarrage.

### À quoi elles servent

- **Vérification du programme** : l'encadré *Programme* indique en vert s'il tient dans la zone (et sur le plateau) avec le zéro actuel, en rouge s'il dépasse. Un dépassement déclenche aussi une alerte au chargement et une confirmation au démarrage.
- **Parcourir le contour** : la tête monte à la **hauteur de survol** puis suit le bord de la zone. Idéal pour vérifier que la pièce est bien placée et bridée hors du passage.
- **Parcourir le cadre du programme** : même chose sur le rectangle occupé par le programme.
- **Clic sur le plateau** : un clic hors du plateau est refusé.

---

## 9. Charger et vérifier un programme

Formats acceptés : `.nc`, `.gcode`, `.ngc`, `.tap`, `.gc`, `.cnc`, `.txt` (G-code texte, 60 Mo maximum).

- Cliquez sur **Ouvrir**, ou **glissez le fichier** sur la vue 3D.

La barre du programme affiche le nombre de lignes, la **durée estimée**, les dimensions et le nombre de changements d'outil. La vue 3D montre le parcours : **bleu** pour l'usinage, **gris** pour les déplacements rapides. Le cône jaune est l'outil.

**Vue 3D :** glisser = tourner, clic droit ou deux doigts = déplacer, molette ou pincement = zoomer. Boutons **3D**, **Dessus**, **Face**, **Cadrer**.

### Placer le programme sur le plateau

Pour déplacer le parcours sur le plateau (par exemple pour usiner dans une chute à un autre endroit) :

1. Cliquez **Placer** en haut de la vue 3D. La vue passe en dessus si un plateau ou une zone est défini.
2. **Glissez le parcours** à la souris ou au doigt. Le décalage s'affiche en direct. Le clic droit (ou deux doigts) déplace toujours la vue, la molette zoome.
3. Au relâchement, une bulle indique le décalage et si le programme **tient dans la zone** à cette position.
4. **Appliquer** valide, **✕** ou **Échap** annule.

Le fichier G-code n'est pas modifié : Copeau **décale l'origine X/Y** du même montant. Le Z ne change pas. La machine doit être **Prêt**, sans usinage en cours.

**À vérifier avant de lancer :**

- Le programme est placé où vous l'attendez par rapport à l'origine (axes rouge X, vert Y, bleu Z).
- Copeau avertit si aucune passe ne descend sous Z0 : souvent signe d'un zéro Z mal placé ou d'un programme prévu avec le zéro en dessous de la pièce.
- L'encadré *Programme* de l'onglet **Zone** est vert.

---

## 10. Lancer, mettre en pause, arrêter

- **Démarrer** : envoie le programme depuis le début. La machine doit être **Prêt**. Copeau demande une confirmation.
- **Pause** : suspend le mouvement immédiatement (maintien d'avance). Le bouton devient **Reprendre**.
- **Arrêter** : ralentit jusqu'à l'arrêt complet, puis vide la mémoire de la carte. La position est conservée : pas besoin de refaire l'origine.

### Suivi en temps réel

Pendant l'usinage :

- le **cône jaune** suit la position réelle de l'outil (5 mises à jour par seconde) ;
- le parcours déjà réalisé passe en **orange** ;
- la barre affiche le pourcentage, la ligne en cours, le temps écoulé et le **temps restant** (recalculé d'après la vitesse réelle) ;
- l'avance et la vitesse broche réelles s'affichent sous les corrections en direct.

Tous les écrans ouverts sur Copeau suivent le même usinage en direct (voir [section 15](#15-utiliser-une-tablette-ou-plusieurs-écrans)).

Si le programme contient un `M0` (pause programmée), la machine passe en **Pause** : cliquez **Reprendre** pour continuer.

**En cas d'erreur Grbl** (ligne refusée), Copeau **met le job en pause** et affiche la ligne en cause, au lieu de continuer avec un programme incomplet. Vous pouvez alors reprendre ou arrêter.

---

## 11. Changement d'outil

Quand le programme contient un `M6` (par exemple `T2 M6`), Copeau :

1. attend que tous les mouvements précédents soient terminés ;
2. affiche une fenêtre avec le numéro d'outil demandé.

Vous pouvez alors :

1. remonter Z et changer l'outil (le jog fonctionne) ;
2. refaire le zéro Z, par exemple avec **Palper Z** ;
3. cliquer **Continuer**.

> La broche n'est arrêtée que si votre programme l'a coupée (`M5`) avant le `M6`. Vérifiez qu'elle est à l'arrêt avant de toucher l'outil.

---

## 12. Reprendre un usinage interrompu

Après une casse d'outil, une coupure ou un arrêt, l'onglet **Reprise** relance le programme à partir d'une ligne.

1. Choisissez la ligne : champ numérique, curseur, ou **clic sur le parcours dans la vue 3D** (pendant que l'onglet Reprise est ouvert). Le point blanc montre où l'outil reprendra. Après un arrêt, Copeau propose la dernière ligne exécutée.
2. Lisez le **préambule** affiché : ce sont les commandes envoyées avant la reprise.
3. Réglez l'**attente broche** (temps de montée en vitesse).
4. Cliquez **Reprendre à cette ligne**.

Copeau rétablit les modes du programme (unités, repère, plan), relance la broche et l'arrosage s'ils étaient actifs, monte à la hauteur la plus haute utilisée jusque-là, se place au-dessus du point de reprise, puis descend en vitesse lente (300 mm/min maximum).

> Les numéros de ligne de Copeau comptent uniquement les lignes envoyées (sans commentaires ni lignes vides). Ils peuvent différer de ceux de votre éditeur de texte : fiez-vous au code affiché.

---

## 13. Corrections en direct

Ces réglages agissent immédiatement, même pendant l'usinage, sans modifier le fichier :

| Réglage | Boutons | Plage |
|---|---|---|
| **Avance** | −10, 100, +10 | 10 à 200 % de l'avance programmée |
| **Broche** | −10, 100, +10 | 10 à 200 % de la vitesse programmée |
| **Rapide** | 25, 50, 100 | 25, 50 ou 100 % de la vitesse des déplacements rapides |

La ligne du dessous rappelle l'avance réelle (`F`), la vitesse broche (`S`) et les modes actifs.

---

## 14. Console, macros et réglages

### Console

Affiche les échanges avec la carte : commandes envoyées (orange), réponses (gris), informations (bleu), erreurs (rouge). Le champ du bas envoie n'importe quelle commande G-code ou `$`. **↑ / ↓** parcourent l'historique. Boutons rapides : `$$` (réglages), `$G` (modes actifs), `$#` (origines), `$I` (version), `M3 S10000` / `M5` (broche).

### Macros

Une macro est une suite de commandes enregistrée sous un nom.

- **Lancer** l'exécute.
- **Modifier** la charge dans l'éditeur.
- **✕** la supprime.
- Pour en créer une : ouvrez *Nouvelle macro / modifier*, donnez un nom et le G-code (une commande par ligne), puis **Enregistrer**.

Deux macros sont fournies : *Garer* (Z en haut, retour X0 Y0) et *Chauffe broche*. Elles sont stockées dans `data/macros.json`.

### Réglages

Liste les paramètres `$` de la carte avec leur description. Modifiez une valeur puis validez : Copeau demande confirmation avant d'écrire dans la carte. Le filtre en haut retrouve un réglage par nom ou numéro.

> Modifier les réglages change le comportement de la machine (pas/mm, vitesses, accélérations, sens des moteurs). Notez les valeurs d'origine avant de les changer.

---

## 15. Utiliser une tablette ou plusieurs écrans

Lancez Copeau avec `HOST=0.0.0.0 npm start`, puis ouvrez `http://<adresse-ip-de-l-ordinateur>:8000` sur la tablette (même réseau Wi-Fi). Sur Mac, l'adresse IP est dans *Réglages Système > Wi-Fi > Détails*.

Tous les écrans ouverts voient et commandent **la même machine** en temps réel : vous pouvez lancer un usinage depuis l'ordinateur et le surveiller depuis l'atelier.

> En mode réseau, toute personne connectée au même réseau peut piloter la machine. Ne l'utilisez que sur un réseau de confiance.

---

## 16. Raccourcis clavier

| Touche | Action |
|---|---|
| ← → ↑ ↓ | Jog X / Y (court = un pas, maintenu = continu) |
| Page ↑ / Page ↓ | Jog Z |
| Échap | Arrête le jog ou le parcours, ferme la bulle *Aller ici*, annule un tracé |
| Entrée | Valide une valeur saisie (position, zone) |
| ↑ / ↓ dans la console | Historique des commandes |

---

## 17. Dépannage

| Problème | Solution |
|---|---|
| Le port n'apparaît pas | Cliquez **↻**. Vérifiez le câble (certains ne transmettent que l'alimentation). Sous Windows, installez le pilote CH340 si la carte en utilise un. |
| « Connexion… » sans fin | Mauvaise vitesse (essayez 115200 puis 250000), ou un autre logiciel (UGS, Candle, CNCjs) occupe déjà le port. |
| Les flèches ne font rien | La machine doit être **Prêt** : faites l'origine ou déverrouillez. Cliquez dans la vue 3D si le curseur est dans un champ de saisie. |
| Le jog s'arrête avant la fin | Limites logicielles atteintes (`$20=1`) : c'est voulu. |
| `error:22` au démarrage | Le programme commence un usinage sans vitesse d'avance `F`. Corrigez le post-processeur de la FAO. |
| `error:20` | Commande non gérée par Grbl (souvent un code spécifique à un autre contrôleur). Retirez-la du programme. |
| `error:9` | La machine est en alarme : voir [section 4](#4-prise-dorigine-et-alarmes). |
| Le programme est décalé dans la vue | Le zéro ne correspond pas à celui prévu dans la FAO : vérifiez où la FAO place X0 Y0 Z0. |
| Palpage : alarme 5 | Pas de contact : rapprochez l'outil, augmentez la course, ou vérifiez la pince. |
| Palpage : alarme 4 | La sonde touchait déjà : vérifiez que la pince ne touche pas la plaque. |
| La page indique « Serveur perdu » | Le terminal où tourne Copeau a été fermé ou l'ordinateur est en veille. Relancez `npm start`, la page se reconnecte seule. |

Pour aller plus loin, l'historique complet des échanges est dans l'onglet **Console**.
