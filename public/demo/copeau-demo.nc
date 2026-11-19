(Copeau - programme de démonstration)
(Pièce 80 x 50 mm, origine X0 Y0 au coin avant gauche, Z0 sur le dessus)
(Outil 1 : fraise droite 6 mm / Outil 2 : foret 3 mm)
G21 G90 G17 G94 G54
T1
M3 S12000
G0 Z5

(1. Contour extérieur en 2 passes de 1.5 mm)
G0 X0 Y0
G1 Z-1.5 F300
G1 X80 Y0 F1200
G1 X80 Y50
G1 X0 Y50
G1 X0 Y0
G0 Z5
G0 X0 Y0
G1 Z-3.0 F300
G1 X80 Y0 F1200
G1 X80 Y50
G1 X0 Y50
G1 X0 Y0
G0 Z5

(2. Poche circulaire Ø30 au centre, profondeur 2 mm, cercles concentriques)
G0 X40 Y25
G1 Z-2 F200
G1 X43 Y25 F900
G3 X43 Y25 I-3 J0
G1 X46 Y25 F900
G3 X46 Y25 I-6 J0
G1 X49 Y25 F900
G3 X49 Y25 I-9 J0
G1 X52 Y25 F900
G3 X52 Y25 I-12 J0
G0 Z5

(3. Changement d'outil : Copeau met le job en attente)
M5
T2 M6
M3 S10000
G0 Z5

(4. Perçages aux quatre coins)
G0 X8 Y8
G1 Z-4 F150
G0 Z5
G0 X72 Y8
G1 Z-4 F150
G0 Z5
G0 X72 Y42
G1 Z-4 F150
G0 Z5
G0 X8 Y42
G1 Z-4 F150
G0 Z5

(Fin : broche arrêtée, retour au-dessus de l'origine)
M5
G0 Z10
G0 X0 Y0
M30
