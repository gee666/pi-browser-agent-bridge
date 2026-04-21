function getRuntimeLastError() {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.lastError) {
    return chrome.runtime.lastError;
  }
  return null;
}

export function storageAreaGet(storageArea, keys) {
  return new Promise((resolve, reject) => {
    try {
      storageArea.get(keys, (result) => {
        const runtimeError = getRuntimeLastError();
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(result || {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function storageAreaSet(storageArea, values) {
  return new Promise((resolve, reject) => {
    try {
      storageArea.set(values, () => {
        const runtimeError = getRuntimeLastError();
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function storageAreaRemove(storageArea, keys) {
  return new Promise((resolve, reject) => {
    if (!storageArea || typeof storageArea.remove !== 'function') {
      resolve();
      return;
    }
    try {
      storageArea.remove(keys, () => {
        const runtimeError = getRuntimeLastError();
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}
