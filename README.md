# JML Estimateur V7.1 PRO — DVF

Version refondue du moteur d'estimation JML Immobilier.

## Principes
- DVF+ géolocalisé comme source principale.
- Aucun appel à l'API Immo Data : 0 crédit consommé.
- Comparables par rayon progressif : 250 m → 500 m → 1 km → 2 km → 3 km → 5 km.
- Score de similarité /100.
- Médiane pondérée plutôt que simple moyenne €/m².
- Filtre IQR pour limiter l'effet des valeurs extrêmes.
- Mutations multi-biens non ventilées artificiellement.
- VEFA et adjudications ne sont pas utilisées comme ventes ordinaires : elles restent séparées par leur nature et reçoivent un facteur de prudence.
- Double contrôle : comparables pondérés + médiane locale.
- Corrections DPE/état/équipements explicitement marquées comme **indicatives JML**, et non comme coefficients officiels DVF.
- Niveau de confiance calculé à partir du nombre de ventes, proximité, similarité, récence et dispersion.

## Types
Maison, appartement, immeuble, terrain constructible, terrain agricole, garage/dépendance, parking, local commercial, industriel/entrepôt, autre.

Pour les types où DVF ne permet pas de produire assez de comparables homogènes, le moteur bloque volontairement l'estimation automatique au lieu d'inventer un prix.

## Installation
```bash
npm install
npm start
```
Puis ouvrir `http://localhost:3000`.

## Configuration
Par défaut : département 08, millésimes 2025 à 2021.

Variables :
- `DVF_DEPT=08`
- `DVF_YEARS=2025,2024,2023,2022,2021`
- `DVF_MILLIME="avril 2026"`
- `PORT=3000`

## Test technique
```bash
npm test
```
Le self-test vérifie les fonctions statistiques et les corrections JML sans télécharger de données.

## Sources
Les données DVF sont produites par la DGFiP à partir des actes notariés et informations cadastrales. DVF+ open-data est proposé par la DGALN/Cerema sous licence ouverte. Le géocodage utilise la Géoplateforme IGN.
