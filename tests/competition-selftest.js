'use strict';
const assert=require('assert');
const {extractCompetitionListing}=require('../server');

const html='<script type="application/ld+json">'+JSON.stringify({
  "@type":"RealEstateListing",
  "name":"Maison test Victor Hugo",
  "offers":{"@type":"Offer","price":"161000","priceCurrency":"EUR"},
  "floorSize":{"@type":"QuantitativeValue","value":"120","unitCode":"MTK"},
  "numberOfRooms":5,
  "address":{"addressLocality":"Charleville-Mézières"}
})+'</script>';

const x=extractCompetitionListing(html,'https://www.seloger.com/annonce/test');
assert.strictEqual(x.price,161000);
assert.strictEqual(x.area,120);
assert.strictEqual(x.rooms,5);
assert.strictEqual(x.sqmPrice,1342);
assert.strictEqual(x.locality,'Charleville-Mézières');
console.log('competition-selftest: OK');
