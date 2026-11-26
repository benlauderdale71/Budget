import type { AssetProfile } from "@budgetcents/domain/asset-identity";

export const assetGuides: Partial<Record<AssetProfile, { name:string; url:string }[]>> = {
  watch: [{name:"WatchCharts reference and price guide",url:"https://watchcharts.com/watches"}],
  car: [{name:"Kelley Blue Book vehicle guide",url:"https://www.kbb.com/whats-my-car-worth/"}],
  atv: [{name:"J.D. Power ATV values",url:"https://www.jdpower.com/motorcycles/atvs"}],
  boat: [{name:"J.D. Power boat values",url:"https://www.jdpower.com/boats"}],
  motorcycle: [{name:"J.D. Power motorcycle values",url:"https://www.jdpower.com/motorcycles"}],
  coin: [{name:"Numista catalog",url:"https://en.numista.com/catalogue/"},{name:"NGC world coin auctions",url:"https://www.ngccoin.com/auction-central/world/"},{name:"PCGS auction prices",url:"https://www.pcgs.com/auctionprices"}],
  banknote: [{name:"Numista banknote catalog",url:"https://en.numista.com/catalogue/index.php?ct=banknote"},{name:"PMG world paper money guide",url:"https://www.pmgnotes.com/priceguide/world-note-price-guide.aspx"}],
  sports_card: [{name:"SportsCardsPro card catalog",url:"https://www.sportscardspro.com/"},{name:"PSA auction prices realized",url:"https://www.psacard.com/auctionprices"}],
  camera: [{name:"MPB dealer quote",url:"https://www.mpb.com/en-us/sell-or-trade"}],
  accessory: [{name:"MPB camera accessory quote",url:"https://www.mpb.com/en-us/sell-or-trade"}],
};
