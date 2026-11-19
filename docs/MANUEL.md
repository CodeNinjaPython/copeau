# Manuel d'utilisation de Copeau

Copeau pilote une fraiseuse CNC équipée d'une carte **Grbl 1.1** ou **grblHAL** depuis un navigateur web, ainsi que les lasers Grbl et la découpeuse laser **Emblaser 2** (voir [section 18](#18-laser--emblaser-2-et-lasers-grbl)). Ce manuel explique comment l'installer, préparer une pièce, lancer un usinage et réagir en cas de problème.

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
18. [Laser : Emblaser 2 et lasers Grbl](#18-laser--emblaser-2-et-lasers-grbl)

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

Les petits boutons **i** ouvrent une bulle d'explication à côté d'un réglage. Un second clic, Échap ou un clic ailleurs la referme.

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
2. Dans le premier menu, choisissez le type de machine : **CNC Grbl** (fraiseuse), **Laser Grbl** ou **Emblaser 2**. Pour un laser, voir aussi la [section 18](#18-laser--emblaser-2-et-lasers-grbl).
3. Cliquez sur **↻** pour rafraîchir la liste des ports.
4. Choisissez le port (sur Mac il ressemble à `/dev/cu.usbserial-…` ou `/dev/cu.usbmodem…`, sur Windows à `COM3`). Pour une machine en Wi-Fi ou Ethernet, choisissez **Réseau** et tapez son adresse IP.
5. Laissez la vitesse à **115200** (valeur standard de Grbl), sauf si votre carte est réglée autrement.
6. Cliquez sur **Connecter**.

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
- **Appui maintenu** : le même pas est répété tant que vous gardez le doigt ou le clic. Avec le pas sur 1 : 1 mm, 1 mm, 1 mm… ; avec 10 : 10 mm, 10 mm… Au relâchement, la tête s'arrête aussitôt, là où elle se trouve.
- **■** : arrêt immédiat du déplacement.
- Les diagonales déplacent X et Y en même temps.

**Vitesse jog** règle l'avance des déplacements en mm/min.

### Au clavier

| Touche | Mouvement |
|---|---|
| ← → | X− / X+ |
| ↑ ↓ | Y+ / Y− |
| + / − (ou Page ↑ / Page ↓) | Z+ / Z− |
| Échap | Arrête tout déplacement |

Même règle : appui = un pas, appui maintenu = le pas répété. Les flèches ne déplacent pas la machine quand vous tapez dans un champ de saisie.

### En cliquant sur le plateau

Cliquez à un endroit de la vue 3D : une cible verte apparaît avec une bulle **Aller ici**. La case **Monter d'abord à Z…** remonte l'outil à la hauteur de survol avant de traverser, pour ne pas frotter la pièce. Le point visé est sur le plan Z0 du repère de travail. Si un plateau est défini, un clic en dehors est refusé.

> **Sécurités du déplacement.** Tous les déplacements passent par le jog de Grbl : ils s'arrêtent avec Échap ou ■. Si la page se ferme ou perd la connexion, plus aucun pas n'est envoyé : la tête s'arrête au plus un pas plus loin. Avec les limites logicielles actives (`$20=1`), un pas qui sortirait de la course est refusé par la carte.

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

### Revenir à l'origine

- **⌂ Origine** ramène l'outil exactement au zéro établi. Il monte d'abord à la hauteur de survol (onglet Zone, 5 mm par défaut) s'il est plus bas, rejoint X0 Y0, puis descend lentement jusqu'à Z0 (300 mm/min au plus). Pratique pour vérifier un zéro avant de lancer.
- **→ X0 Y0** fait la même chose sans descendre : l'outil s'arrête au-dessus de l'origine, à la hauteur de survol.
- Le **⌂** de chaque ligne X, Y ou Z ramène **seulement cet axe** à 0, les autres ne bougent pas. Z descend lentement vers Z0 (300 mm/min au plus) ; X et Y se déplacent à la hauteur actuelle, avec une confirmation si l'outil est sous Z0.

Les deux passent par le jog : **Échap** ou **■** arrêtent le mouvement à tout moment.

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

### Sans sonde (méthode de la feuille)

Sans sonde électrique, Copeau guide la méthode classique de la feuille de papier.

1. Onglet **Palpage**, choisissez **Sans sonde**.
2. Choisissez ce que vous palpez : **Dessus Z**, **Bord gauche**, **Bord droit**, **Bord avant** ou **Bord arrière**.
3. Indiquez l'**épaisseur de la feuille** (environ 0,1 mm pour du papier ordinaire, ou l'épaisseur exacte d'une cale) et, pour un bord, le **diamètre de l'outil**.
4. Broche **à l'arrêt**, glissez la feuille entre l'outil et la pièce.
5. Approchez avec le gros bouton (**▼ Descendre** ou **→ Approcher**) : d'abord en pas de 0,5 ou 1 mm, puis en **0,01 mm** quand la feuille commence à frotter. Les touches **+ / −** et les flèches marchent aussi.
6. Quand la feuille se coince, cliquez **✓ Contact**.

Copeau pose l'origine en retranchant l'épaisseur de la feuille (et le rayon de l'outil pour un bord), puis dégage l'outil de 2 mm (désactivable). Pour un coin, faites le dessus, puis un bord X, puis un bord Y.

Le bouton **Palper Z** de la fenêtre de changement d'outil lance un palpage Z avec les derniers réglages utilisés.

---

## 8. Plateau et zone de travail

L'onglet **Zone** décrit deux formes, dessinées dans la vue 3D :

- **Plateau** (gris) : la **course de la machine**, c'est-à-dire sa taille de travail maximale en X × Y × Z. Le volume est dessiné en fil de fer.
- **Zone de travail** (jaune) : l'endroit où se trouve la pièce. Rectangle ou cercle.

### Trois façons de les définir

1. **Capturer** : amenez l'outil sur un coin, cliquez **Capturer** du *Coin 1* ; faites de même pour le coin opposé (*Coin 2*). Pour un cercle : capturez le **Centre**, puis amenez l'outil sur le bord et cliquez **Point du bord**.
2. **Tracer sur la vue** : la vue passe en dessus. Cliquez un premier coin (ou le centre), un aperçu vert suit la souris, cliquez le coin opposé (ou un point du bord). Échap annule.
3. **Saisir** les valeurs en coordonnées travail (celles des grands chiffres).

### Saisir la course de la machine

La ligne **Course** de la carte *Plateau* accepte la course de chaque axe en mm (X, Y et Z). Si la machine est connectée, les champs sont préremplis avec les valeurs de la carte (`$130`, `$131`, `$132`) ; **Lire la carte** les recharge.

Choisissez l'**ancrage**, puis **Appliquer** (ou Entrée) :

| Ancrage | Position du volume |
|---|---|
| **Origine machine (Grbl, vers X− Y−)** | Choix par défaut. Après une prise d'origine, Grbl travaille de 0 vers les X, Y et Z négatifs. |
| **Coin 1 fixe** | Le coin 1 ne bouge pas, le rectangle est redimensionné dans son sens actuel. |
| **Outil = coin avant gauche** | Pour une machine sans prise d'origine : amenez l'outil au coin avant gauche, puis appliquez. |

La case **Écrire aussi dans la carte** enregistre la course dans Grbl (`$130` à `$132`), après confirmation. Grbl s'en sert pour les limites logicielles (`$20=1`) et la prise d'origine. Mesurez la course réelle : une valeur trop grande peut envoyer un axe en butée.

Avec une course Z, Copeau vérifie aussi que le programme ne descend pas plus bas (ni ne monte plus haut) que ce que la machine peut atteindre avec le zéro actuel.

Raccourci : **Depuis le programme** crée une zone de travail au cadre du programme chargé.

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

### Simuler l'usinage avant de lancer

**▶ Simuler** (en haut de la vue 3D) joue l'usinage sans rien envoyer à la machine :

- un **outil vert** parcourt le trajet à la vitesse du programme (avances et rapides) ;
- un bloc de **matière** virtuel, dessus à Z0, se creuse au passage d'une fraise droite du diamètre choisi ;
- le parcours déjà simulé passe en vert ; l'outil jaune reste la position réelle de la machine.

| Commande | Rôle |
|---|---|
| ▶ / ⏸ ou **Espace** | Lecture / pause |
| ⏮ | Retour au début |
| Curseur | Aller à n'importe quel moment (avant ou arrière) |
| 1× à 100× | Vitesse de lecture (1× = temps réel) |
| Ø | Diamètre de la fraise simulée |
| Matière | Affiche ou masque le bloc |
| ✕ ou **■ Simulation** | Quitte la simulation |

Sous le curseur s'affichent le temps simulé, la durée totale et la ligne de G-code en cours. La simulation se ferme d'elle-même si un nouveau programme est chargé ou si l'usinage réel démarre.

> La simulation suppose une fraise droite et un dessus de pièce à Z0. Elle sert à vérifier les trajets, les profondeurs et l'ordre des opérations. Elle ne reproduit ni les accélérations de la machine ni les efforts de coupe : la durée réelle sera un peu plus longue.

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

### Couper la broche pendant une pause

- Pendant une pause (ou un `M0`), le bouton **⏻ Couper la broche** arrête la broche dès que le mouvement est complètement arrêté.
- La case **Couper la broche en pause** (sous la barre de progression) le fait automatiquement à chaque **Pause**.
- À la **reprise**, Copeau rallume la broche, attend sa montée en vitesse (réglage *Attente broche* de l'onglet Reprise, 3 s par défaut), puis seulement reprend le mouvement. La barre affiche le compte à rebours.

Pratique pour dégager un copeau ou contrôler une passe. Ce n'est pas un arrêt d'urgence : la broche peut être relancée par la reprise.

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

1. Choisissez la ligne : champ numérique, curseur, ou **clic sur le parcours dans la vue 3D** (pendant que l'onglet Reprise est ouvert). Le point blanc montre où l'outil reprendra. Après un arrêt, Copeau propose la ligne du parcours la plus proche de la position réelle de l'outil (la carte accepte les lignes bien avant de les usiner : la dernière ligne envoyée serait trop loin).
2. Lisez le **préambule** affiché : ce sont les commandes envoyées avant la reprise.
3. Réglez l'**attente broche** (temps de montée en vitesse).
4. Cliquez **Reprendre à cette ligne**.

Copeau rétablit les modes du programme (unités, repère, plan), relance la broche et l'arrosage s'ils étaient actifs, monte à la hauteur la plus haute utilisée jusque-là (au moins la **hauteur de survol** de l'onglet Zone, 5 mm par défaut, utile pour les programmes qui dégagent en `G53`), se place au-dessus du point de reprise, puis descend en vitesse lente (300 mm/min maximum).

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

Affiche les échanges avec la carte : commandes envoyées (orange), réponses (gris), informations (bleu), erreurs (rouge). Pendant un usinage (ou sa pause), seules les lectures (`$G`, `$#`, `$I`, `$$`) sont acceptées : une autre commande s'insérerait au milieu du programme. Les macros suivent la même règle. Le champ du bas envoie n'importe quelle commande G-code ou `$`. **↑ / ↓** parcourent l'historique. Boutons rapides : `$$` (réglages), `$G` (modes actifs), `$#` (origines), `$I` (version), `M3 S10000` / `M5` (broche).

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

> En mode réseau, toute personne connectée au même réseau peut piloter la machine. Ne l'utilisez que sur un réseau de confiance. Les pages d'autres sites web ouvertes dans un navigateur, elles, ne peuvent pas se connecter à Copeau.

---

## 16. Raccourcis clavier

| Touche | Action |
|---|---|
| ← → ↑ ↓ | Jog X / Y (appui = un pas, maintenu = le pas répété) |
| + / − ou Page ↑ / Page ↓ | Jog Z (rangée principale ou pavé numérique) |
| Espace | Lecture / pause de la simulation |
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
| Le jog s'arrête avant la fin | Limites logicielles atteintes (`$20=1`) : c'est voulu. Vérifiez que la course (`$130` à `$132`) correspond à la machine. |
| `error:22` au démarrage | Le programme commence un usinage sans vitesse d'avance `F`. Corrigez le post-processeur de la FAO. |
| `error:20` | Commande non gérée par Grbl (souvent un code spécifique à un autre contrôleur). Retirez-la du programme. |
| `error:9` | La machine est en alarme : voir [section 4](#4-prise-dorigine-et-alarmes). |
| Le programme est décalé dans la vue | Le zéro ne correspond pas à celui prévu dans la FAO : vérifiez où la FAO place X0 Y0 Z0. |
| Palpage : alarme 5 | Pas de contact : rapprochez l'outil, augmentez la course, ou vérifiez la pince. |
| Palpage : alarme 4 | La sonde touchait déjà : vérifiez que la pince ne touche pas la plaque. |
| « La carte ne répond pas » | Mauvais port ou mauvaise vitesse : essayez 115200 puis 250000. |
| « Positions en pouces ($13=1) » | Copeau travaille en mm : envoyez `$13=0` dans la console. |
| « Usinage en cours : commande refusée » | Normal pendant un usinage : utilisez Pause, Arrêter ou les corrections en direct. |
| La page indique « Serveur perdu » | Le terminal où tourne Copeau a été fermé ou l'ordinateur est en veille. Relancez `npm start`, la page se reconnecte seule. |
| Emblaser 2 : « La carte ne répond pas » | Le profil **Emblaser 2** est-il choisi ? LightBurn ou LaserGRBL sont-ils fermés ? Le câble USB transmet-il les données ? |
| « Mode laser désactivé ($32=0) » | Laser Grbl : envoyez `$32=1` dans la console, sinon le laser reste allumé pendant les déplacements. |
| Gravure trop pâle ou trop foncée partout | **S max** ne correspond pas à la carte (`$30` pour Grbl, `laser_module_maximum_s_value` pour l'Emblaser 2). |
| Emblaser 2 : à la pause, la tête continue un peu | Normal sans `grbl_mode` : la carte finit les mouvements déjà reçus. Voir [section 18](#18-laser--emblaser-2-et-lasers-grbl). |

Pour aller plus loin, l'historique complet des échanges est dans l'onglet **Console**.

---

## 18. Laser : Emblaser 2 et lasers Grbl

> **Sécurité laser.** Le faisceau d'une diode de 5 ou 10 W brûle la peau et détruit la rétine, même par réflexion. Couvercle fermé, lunettes adaptées à la longueur d'onde (445–455 nm pour l'Emblaser 2), aspiration en marche, extincteur à portée, et **jamais de gravure sans surveillance**. Copeau n'est pas un dispositif de sécurité : l'interrupteur et le couvercle de la machine le sont.

### Choisir le type de machine

Le premier menu de la barre du haut indique ce qui est branché :

| Type | Carte | Particularités |
|---|---|---|
| **CNC Grbl (fraiseuse)** | Grbl, grblHAL | Comportement habituel de Copeau. |
| **Laser Grbl ($32=1)** | Grbl ou grblHAL en mode laser | Puissance au lieu de la broche, `S` de 0 à `$30` (souvent 1000). |
| **Emblaser 2 (Smoothieware)** | Firmware Darkly Labs, basé sur Smoothieware | Ce n'est **pas** du Grbl : Copeau parle son protocole. `S` de 0 à 1. |

Le choix est mémorisé et partagé entre les écrans. Il ne change pas pendant une connexion : déconnectez d'abord.

### Connecter l'Emblaser 2

- **En USB** : choisissez le port (`COM…` sous Windows, `/dev/cu.usbmodem…` sur Mac). La vitesse est inutile, elle disparaît.
- **En Wi-Fi** : choisissez **Réseau (Wi-Fi / Ethernet)…** et tapez l'adresse IP de la machine (visible dans l'interface web de l'Emblaser ou dans votre box), suivie du port s'il n'est pas 23 : `192.168.1.50:23`. Cette liaison n'a été essayée qu'avec une console simulée : faites un premier essai sans matière.
- Fermez **LightBurn** ou **LaserGRBL** avant : un seul logiciel peut parler à la machine.

La console affiche `Connecté : Smoothieware`, puis la version du firmware (réponse à `M115`). L'Emblaser fait sa prise d'origine à la mise sous tension ; **Origine** la relance. **Déverrouiller** envoie `M999`, la commande Smoothieware qui lève un arrêt (HALT).

Copeau n'envoie à l'Emblaser que des commandes qu'il comprend : les commandes temps réel de Grbl (corrections, annulation de jog) y seraient collées à la ligne suivante et la feraient ignorer.

### Ce qui change en mode laser

- **Le laser ne tire que pendant les mouvements de gravure** (`G1`, `G2`, `G3` avec une puissance `S`). Les déplacements `G0`, les jogs, le cadre et les retours à l'origine se font laser éteint.
- L'onglet **Palpage** disparaît, la tête ne monte plus au Z de survol avant de se déplacer (le Z sert à la mise au point) et il n'y a plus d'attente de broche.
- **Pause** : un laser Grbl éteint le laser pendant la pause. L'Emblaser 2 s'arrête aussitôt si sa configuration a `grbl_mode` (ou `enable_feed_hold`) ; sinon Copeau n'envoie plus rien et la machine **finit les mouvements déjà reçus** (quelques millimètres à quelques centimètres) avant de s'arrêter. La console indique, à la connexion, lequel des deux cas s'applique.
- **Arrêter** (Emblaser 2) : arrêt immédiat de la carte (Ctrl-X), laser coupé, puis `M999`. La position est conservée ; si la tête a pu sauter des pas, refaites l'origine.
- **Corrections en direct** : **Avance** et **Puissance** (−10 / +10 %) agissent pendant la gravure. Sur l'Emblaser 2 elles passent par `M220` et `M221` ; la correction des rapides n'existe pas.
- **Reprise** : la tête rejoint le point de reprise laser éteint, puis le laser se rallume à la puissance du programme.
- **Simulation** : sans matière à creuser ; la vue montre la puissance de chaque trait (plus il est clair, plus le laser est fort). Les traits gris sont des déplacements laser éteint.

### Tir de repérage

Le panneau **Laser** allume le laser à très faible puissance (1 % par défaut), tête immobile, pour voir où tombe le point et poser l'origine (**Zéro XY**). Au-delà de 5 %, Copeau demande confirmation : le laser marque alors la matière.

Le laser s'éteint au second clic, tout seul au bout de **60 s**, si l'écran qui l'a allumé se déconnecte, et Copeau refuse de démarrer une gravure tant qu'il est allumé. Un laser Grbl l'éteint pendant un jog : rallumez-le une fois la tête arrêtée. L'Emblaser 2 le garde allumé pendant les déplacements.

### Cadre du programme

**⬚ Cadre du programme** fait le tour du rectangle qui contient le programme, à la hauteur actuelle, laser éteint : vérifiez que la gravure tombe sur la matière. Sur l'Emblaser 2, cochez **pointeur allumé** pour voir le trajet sur la matière. <kbd>Échap</kbd> arrête.

### S max

Valeur de `S` qui correspond à 100 % de puissance : `$30` pour Grbl (lue dans la carte), `laser_module_maximum_s_value` pour l'Emblaser 2 (1 par défaut, donc `S0.5` = 50 %). Elle doit être la même que dans le logiciel qui prépare vos fichiers. Si toutes les gravures sont trop pâles ou brûlées, c'est la première chose à vérifier.

### Graver une image

Comme le mode « ligne à ligne » de LaserGRBL, Copeau transforme une image (PNG, JPG…) en G-code :

1. Bouton **Image…** de la barre du programme, choisissez le fichier.
2. Réglez le mode, la taille, la résolution, la vitesse et la puissance. L'aperçu montre ce qui sera gravé (noir = puissance max demandée) et la durée estimée.
3. **Générer et charger** : le programme est chargé comme un fichier ordinaire. Regardez-le en vue **Dessus**, faites le **cadre**, puis **Démarrer**.

| Réglage | Rôle |
|---|---|
| **Niveaux de gris** | La puissance suit la teinte : photos. |
| **Noir et blanc** | Tout ou rien selon le seuil : logos, textes. |
| **Tramage** | Points tout ou rien qui imitent les gris (Floyd–Steinberg) : photos sur bois clair. |
| **Résolution** | Lignes par mm. 10 (0,1 mm) convient à une diode de 5 W. |
| **Puissance min / max** | Le blanc n'est pas gravé ; le gris le plus clair part de la puissance min, le noir est à la puissance max. |
| **Marge d'accélération** | La tête démarre un peu avant chaque ligne, laser éteint, pour graver à vitesse constante. |
| **Origine** | X0 Y0 au coin bas gauche ou au centre de l'image. |
| **Inverser** | Grave les zones claires (matières foncées, ardoise). |

Les zones blanches ou transparentes ne sont pas parcourues. Faites toujours un essai sur une chute de la même matière pour trouver le bon couple vitesse / puissance.

### Et LaserGRBL, LightBurn ?

**LaserGRBL** est un logiciel Windows séparé, conçu pour les lasers Grbl ; son auteur indique que sa prise en charge de Smoothieware (le firmware de l'Emblaser 2) est expérimentale. Copeau ne l'intègre pas, mais reprend sa fonction principale (gravure d'image ligne à ligne) et peut exécuter les fichiers qu'il produit : enregistrez le programme en `.nc` ou `.gcode` dans LaserGRBL ou LightBurn, avec le même **S max**, puis ouvrez-le dans Copeau. Fermez l'autre logiciel avant de connecter Copeau.
