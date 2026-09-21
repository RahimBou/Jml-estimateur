JML Estimateur V8 — feuille blanche
Algorithme
DVF uniquement : ventes de nature Vente, sans prix saisi par le propriétaire.
Fenêtre temporelle : maximum 24 mois avant la date d'analyse.
Type : correspondance stricte du type DVF.
Géographie : distance réelle par coordonnées, avec sélection adaptative jusqu'à 2 km.
Surface : comparables entre 60 % et 170 % de la surface cible.
Similarité : type, distance, surface, pièces, terrain et récence.
Tendance locale : médianes trimestrielles locales en €/m² et pente robuste sur les logarithmes. La tendance sert uniquement à ramener chaque vente à la date d'analyse.
Effet de taille : estimation statistique locale de l'élasticité surface / €/m², plafonnée pour éviter les corrections extrêmes.
Prix central : médiane pondérée des €/m² normalisés, puis multiplication par la surface cible.
Filtre IQR : suppression des valeurs aberrantes après normalisation.
Fourchette : exactement estimation - 20 000 € à estimation + 20 000 €, conformément à la demande.
DPE / état / équipements : pas de conversion arbitraire en euros. Sans calibration statistique locale, ces données servent à l'information mais ne déforment pas le prix DVF.
Pourquoi la tendance n'est pas une deuxième source
Une vente de 2024 peut être plus ancienne que le marché de 2026. On ajuste donc son €/m² à la date d'analyse. On ne calcule pas une "tendance = 276 900 €" puis on l'ajoute aux comparables.
Important
L'estimateur produit une estimation de marché fondée sur les transactions disponibles. Ce n'est pas une expertise immobilière réglementaire et la qualité dépend de la quantité et de la représentativité des transactions DVF disponibles localement.
