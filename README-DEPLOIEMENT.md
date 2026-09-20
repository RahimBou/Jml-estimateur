# JML Estimateur — version Web 6.2

Cette version est prête à être hébergée sur Render.

## Mode test gratuit
`MOCK_API_MODE=true` est activé dans `render.yaml` : aucune requête Immo Data réelle n'est envoyée et aucun crédit API n'est consommé.

## Mise en ligne
1. Mettre ces fichiers dans un dépôt GitHub.
2. Sur Render : New > Web Service > connecter le dépôt.
3. Render détecte `render.yaml`, ou utiliser :
   - Build : `npm install`
   - Start : `npm start`
4. Vérifier `/api/health`.

## Passage à Immo Data réel
Après validation du fonctionnement, remplacer `MOCK_API_MODE=true` par `false` et ajouter `IMMO_DATA_API_KEY` dans les variables d'environnement Render. Ne jamais mettre la clé dans le HTML ou GitHub.
