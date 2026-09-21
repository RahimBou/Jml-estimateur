'use strict';
const assert=require('assert');
const {extractCompetitionListing,similarityForCompetition,extractSearchResultLinks}=require('../server');

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


const similar=similarityForCompetition(
  {title:'Maison à vendre',price:161000,area:120,landArea:294,rooms:5,locality:'Charleville-Mézières'},
  {realtyType:'house',livingArea:120,landArea:300,rooms:5,city:'Charleville-Mézières'}
);
assert.ok(similar && similar.similarity>=90);

const notSimilar=similarityForCompetition(
  {title:'Maison à vendre',price:300000,area:180,landArea:1000,rooms:3,locality:'Charleville-Mézières'},
  {realtyType:'house',livingArea:120,landArea:300,rooms:5,city:'Charleville-Mézières'}
);
assert.strictEqual(notSimilar,null);

const searchHtml='<a class="result__a" href="https://www.seloger.com/annonce/test">Maison test</a>';
assert.strictEqual(extractSearchResultLinks(searchHtml)[0].url,'https://www.seloger.com/annonce/test');
console.log('competition-similarity-selftest: OK');
