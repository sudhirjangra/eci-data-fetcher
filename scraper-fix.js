sed -i '463s/await Promise.all(promises);/for (let i = 0; i < promises.length; i++) { await new Promise(r => setTimeout(r, 2000)); await promises[i]; }/' scraper.js
