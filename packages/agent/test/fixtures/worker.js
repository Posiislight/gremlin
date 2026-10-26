// self.name carries the URL the worker POSTs to.
fetch(self.name, { method: 'POST', body: 'w', mode: 'no-cors' }).catch(() => {});
