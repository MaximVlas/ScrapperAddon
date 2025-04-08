// Background script for Image Scraper Pro

// Set up browser API compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Initialize state
let scrapeState = {
  isSelecting: false,
  activeTab: null,
  selectedElements: 0,
  scrapedImages: []
};

// Listen for messages from content scripts
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check if it's a valid message
  if (!message || (!message.type && !message.action)) {
    return false;
  }
  
  console.log('Background received message:', message, 'from', sender.tab?.id);
  
  // Handle selection update messages
  if (message.type === 'selectionUpdate') {
    scrapeState.selectedElements = message.payload.elementCount || 0;
    scrapeState.isSelecting = scrapeState.selectedElements === 0;
    scrapeState.activeTab = sender.tab?.id;
    
    // Store selection info in storage for persistence
    browserAPI.storage.local.set({
      selectedElements: scrapeState.selectedElements,
      activeTab: scrapeState.activeTab,
      selectionState: scrapeState.selectedElements > 0 ? 'selected' : 'selecting'
    });
    
    // If popup is open, relay message
    relayMessageToPopup(message);
    return false;
  }
  
  // Handle scrape result messages
  if (message.type === 'scrapeResult' || 
      message.type === 'screenshotResult' || 
      message.type === 'screenshotProgress') {
    
    // Store result in state and storage
    if (message.type === 'scrapeResult' && !message.payload.error) {
      scrapeState.scrapedImages = extractImagesFromPayload(message.payload);
      browserAPI.storage.local.set({ 
        scrapedImages: scrapeState.scrapedImages,
        selectionState: 'completed'
      });
    } else if (message.type === 'screenshotResult' && !message.payload.error) {
      browserAPI.storage.local.set({ 
        screenshots: message.payload.screenshots,
        selectionState: 'completed'
      });
    }
    
    // Reset selection state if operation completed or failed
    if (message.payload.error || 
        (message.type === 'scrapeResult' && !message.payload.error) || 
        (message.type === 'screenshotResult' && !message.payload.error)) {
      
      scrapeState.isSelecting = false;
      scrapeState.selectedElements = 0;
    }
    
    // Relay message to popup
    relayMessageToPopup(message);
    return false;
  }
  
  return false;
});

// Extract images from scrape result payload
function extractImagesFromPayload(payload) {
  const images = [];
  
  if (payload.elements && Array.isArray(payload.elements)) {
    payload.elements.forEach(element => {
      if (element.images && Array.isArray(element.images)) {
        element.images.forEach(img => {
          images.push(img);
        });
      }
    });
  }
  
  return images;
}

// Relay a message to the popup if it's open
function relayMessageToPopup(message) {
  // First try to query if any popups are open
  browserAPI.runtime.getViews({ type: 'popup' }).forEach(view => {
    try {
      // If the view has a window object, send the message
      if (view && view.postMessage) {
        view.postMessage({
          source: 'background',
          payload: message
        }, '*');
      }
    } catch (error) {
      console.error('Error relaying message to popup:', error);
    }
  });
}

// Listen for browser action clicks
browserAPI.action.onClicked.addListener((tab) => {
  // This only fires if we don't have a popup defined
  console.log('Browser action clicked, tab ID:', tab.id);
});

// Listen for tab removal to clean up state
browserAPI.tabs.onRemoved.addListener((tabId) => {
  if (tabId === scrapeState.activeTab) {
    console.log('Active tab closed, cleaning up state');
    scrapeState = {
      isSelecting: false,
      activeTab: null,
      selectedElements: 0,
      scrapedImages: []
    };
    
    browserAPI.storage.local.set({
      selectionState: 'default',
      activeTab: null,
      selectedElements: 0,
      scrapedImages: []
    });
  }
}); 