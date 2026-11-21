# Pêche à La Réunion – base de données

Base structurée sur la pêche à La Réunion : techniques, espèces, zones, réglementation, calendrier, glossaire créole et sources.

| Fichier | Contenu |
|---|---|
| `data.py` | **Source unique** des données (à modifier ici) |
| `build.py` | Régénère tous les fichiers ci-dessous : `python3 build.py` |
| `peche_reunion.sqlite` | Base SQLite (tables `technique`, `espece`, `zone`, `regle`, `source`, liaisons `technique_espece`, `technique_zone`, `reference`, plus `calendrier`, `glossaire`, `chiffre`) |
| `peche_reunion.json` | Même contenu en JSON |
| `csv/*.csv` | Une table par fichier (séparateur `;`, UTF-8 avec BOM pour Excel) |
| `explorateur.html` | Explorateur hors ligne (recherche, filtres, carte schématique) |

## Fiabilité

Chaque enregistrement porte un champ `fiabilite` :

- `officiel` : repris d'un texte officiel cité (guide DMSOI 2024, arrêtés 1743/2008, 3416/2019, 2687/2021, arrêté requin 297/2025, IEDOM…)
- `usage` : savoir de terrain ou connaissance générale, **à vérifier**

Les coordonnées sont approximatives. Les règles changent : la pêche des bichiques est en cours de révision (bilan 2025) et l'arrêté eau douce est republié chaque année. Vérifiez toujours la version en vigueur sur le site de la [DMSOI](https://www.dm.sud-ocean-indien.developpement-durable.gouv.fr/).

## Exemples de requêtes SQL

```sql
-- Espèces interdites ou protégées
SELECT nom, nom_local FROM espece WHERE statut IN ('interdite','protegee');

-- Techniques pratiquables dans une zone donnée
SELECT t.nom FROM technique t JOIN technique_zone tz ON tz.technique_id = t.id
WHERE tz.zone_id = 'Z04';

-- Ce qui est ouvert en mars
SELECT sujet FROM calendrier WHERE mois = 3 AND type = 'reglementaire';
```

Secours en mer : CROSS Sud océan Indien, VHF canal 16, téléphone 196.
