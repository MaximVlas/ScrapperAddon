// dom-to-image is now loaded from the manifest content_scripts

class ElementScraper {
  constructor() {
    this.selectedElements = [];
    this.observer = null;
    this.styleTag = null;
    this.browserAPI = typeof browser !== 'undefined' ? browser : chrome;
    this.isSelecting = false;
    this.setupListeners();
    this.restoreSelectionState();
  }

  setupListeners() {
    // Ensure we're properly listening for messages
    this.browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      console.log('Content script received message:', msg);
      try {
        switch(msg.action) {
          case 'startSelection':
            this.startSelection();
            sendResponse({status: 'success'});
            break;
          case 'scrapeImages':
            this.scrapeImages();
            sendResponse({status: 'success'});
            break;
          case 'captureScreenshot':
            this.captureScreenshot();
            sendResponse({status: 'success'});
            break;
          case 'retryScreenshot':
            this.retryScreenshot(msg.elementId);
            sendResponse({status: 'success'});
            break;
          case 'cancelActions':
            this.cleanup();
            sendResponse({status: 'success'});
            break;
          case 'getSelectionState':
            sendResponse({
              status: 'success',
              isSelecting: this.isSelecting,
              hasSelectedElement: this.selectedElements.length > 0
            });
            break;
        }
      } catch (error) {
        console.error('Error handling message:', error);
        sendResponse({status: 'error', message: error.message});
      }
      return true; // Keep the message channel open for async response
    });
  }

  async restoreSelectionState() {
    try {
      // Check storage to see if we're in a selection state
      const result = await this.browserAPI.storage.local.get(['selectionState']);
      
      // If we were in selection mode for this tab and the popup was closed
      if (result.selectionState === 'selecting') {
        // Re-inject styles for selection mode
        this.injectStyles();
        this.isSelecting = true;
      }
    } catch (error) {
      console.error('Failed to restore selection state:', error);
    }
  }

  startSelection() {
    this.injectStyles();
    this.isSelecting = true;
    document.addEventListener('mouseover', this.handleMouseOver);
    document.addEventListener('click', this.handleElementSelect);
    document.addEventListener('keydown', this.handleEscape);
  }

  handleMouseOver = (e) => {
    if (!this.isSelecting) return;
    this.highlightElement(e.target);
  };

  handleElementSelect = (e) => {
    if (!this.isSelecting) return;
    e.preventDefault();
    e.stopPropagation();
    
    const target = e.target;
    const index = this.selectedElements.findIndex(el => el === target);
    
    if (index >= 0) {
      // If already selected, remove it
      this.selectedElements.splice(index, 1);
      target.classList.remove('scraper-selected');
    } else {
      // Add to selected elements
      this.selectedElements.push(target);
      target.classList.add('scraper-selected');
    }
    
    this.sendSelectionUpdate();
    
    // Don't clean up - we continue selecting until explicitly canceled
  };

  handleEscape = (e) => {
    if (e.key === 'Escape') this.cleanup();
  };

  highlightElement(element) {
    document.querySelectorAll('.scraper-highlight').forEach(el => {
      if (el !== element && !this.selectedElements.includes(el)) {
        el.classList.remove('scraper-highlight');
      }
    });
    
    if (!this.selectedElements.includes(element)) {
      element.classList.add('scraper-highlight');
    }
  }

  clearHighlights() {
    document.querySelectorAll('.scraper-highlight').forEach(el => {
      if (!this.selectedElements.includes(el)) {
        el.classList.remove('scraper-highlight');
      }
    });
  }

  sendSelectionUpdate() {
    this.browserAPI.runtime.sendMessage({
      type: 'selectionUpdate',
      payload: {
        selected: this.selectedElements.length > 0,
        elementCount: this.selectedElements.length,
        elementTypes: this.selectedElements.map(el => el.tagName)
      }
    });
    
    // Update storage to reflect selection
    this.browserAPI.storage.local.set({ 
      selectionState: this.selectedElements.length > 0 ? 'selected' : 'selecting',
      hasSelectedElements: this.selectedElements.length > 0
    });
  }

  async scrapeImages() {
    try {
      // If no elements are selected, notify the user
      if (this.selectedElements.length === 0) {
        this.browserAPI.runtime.sendMessage({
          type: 'scrapeResult',
          payload: { error: 'No elements selected. Please select at least one element first.' }
        });
        return;
      }
      
      // Scrape images from each selected element
      const elementResults = this.selectedElements.map((element, index) => {
        const images = Array.from(element.querySelectorAll('img'))
          .map(img => ({
            src: img.src,
            alt: img.alt,
            width: img.naturalWidth,
            height: img.naturalHeight
          }));
        
        return {
          elementId: index,
          elementType: element.tagName,
          images: images
        };
      });
      
      const totalImages = elementResults.reduce((total, result) => total + result.images.length, 0);
      
      this.browserAPI.runtime.sendMessage({
        type: 'scrapeResult',
        payload: {
          count: totalImages,
          elements: elementResults
        }
      });
      
    } catch (error) {
      this.browserAPI.runtime.sendMessage({
        type: 'scrapeResult',
        payload: { error: 'Failed to scrape images' }
      });
    }
    this.cleanup();
  }

  async captureScreenshot() {
    try {
      // Check if dom-to-image is loaded (loaded via manifest)
      if (typeof domtoimage === 'undefined' || typeof domtoimage !== 'object') {
        console.error('dom-to-image library not found or not loaded correctly.');
        this.browserAPI.runtime.sendMessage({
          type: 'screenshotResult',
          payload: { error: 'Screenshot library failed to load. Please try refreshing the page.' }
        });
        return; 
      }

      // If no elements are selected, notify the user
      if (this.selectedElements.length === 0) {
        this.browserAPI.runtime.sendMessage({
          type: 'screenshotResult',
          payload: { error: 'No elements selected. Please select at least one element first.' }
        });
        return;
      }

      // Initialize progress tracking
      let totalElements = this.selectedElements.length;
      let capturedElements = 0;
      let errorElements = 0;
      
      // Send initial progress
      this.browserAPI.runtime.sendMessage({
        type: 'screenshotProgress',
        payload: {
          total: totalElements,
          completed: capturedElements,
          errors: errorElements
        }
      });

      // Get settings from storage (or use defaults)
      const settings = await this.browserAPI.storage.local.get({
        'screenshotQuality': 0.92,
        'screenshotFormat': 'png',
        'screenshotScale': 1, // Default scale/DPR
        'maxRetries': 2
      });

      // Process each selected element
      const screenshots = [];

      for (let i = 0; i < this.selectedElements.length; i++) {
        const element = this.selectedElements[i];
        
        // Update progress
        this.browserAPI.runtime.sendMessage({
          type: 'screenshotProgress',
          payload: {
            total: totalElements,
            completed: capturedElements,
            errors: errorElements,
            currentElement: i + 1,
            elementType: element.tagName
          }
        });
        
        // Remove selection styles temporarily for the screenshot
        element.classList.remove('scraper-selected');
        const originalStyles = this.prepareElementForCapture(element);
        
        try {
          // Add a small delay to potentially allow images inside the element to render
          await new Promise(resolve => setTimeout(resolve, 100)); 

          // Configure capture options for this specific element
          const captureOptions = {
            bgcolor: null,
            height: element.scrollHeight,
            width: element.scrollWidth,
            style: {
              'transform': 'none',
              'transform-origin': 'center',
            },
            imagePlaceholder: 'data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D\'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg\' width=\'1\' height=\'1\'%3E%3C%2Fsvg%3E',
            quality: settings.screenshotQuality,
            cacheBust: true,
            scale: settings.screenshotScale
          };
          
          // Try capturing with retries
          let dataUrl = null;
          let attempts = 0;
          let success = false;
          
          while (!success && attempts <= settings.maxRetries) {
            try {
              attempts++;
              
              // Choose capture method based on format
              if (settings.screenshotFormat === 'jpeg') {
                dataUrl = await domtoimage.toJpeg(element, captureOptions);
              } else if (settings.screenshotFormat === 'svg') {
                dataUrl = await domtoimage.toSvg(element, captureOptions);
              } else {
                // Default to PNG
                dataUrl = await domtoimage.toPng(element, captureOptions);
              }
              
              success = true;
            } catch (captureError) {
              console.warn(`Screenshot attempt ${attempts} failed:`, captureError);
              
              if (attempts > settings.maxRetries) {
                throw captureError; // Re-throw if we've exhausted retries
              }
              
              // Wait briefly before retrying (with increasing delay)
              await new Promise(resolve => setTimeout(resolve, 200 * attempts));
              
              // Try with different settings on retry
              if (attempts === 1) {
                // First retry: try with background
                captureOptions.bgcolor = '#ffffff';
              } else {
                // Second retry: try with lower scale
                captureOptions.scale = Math.max(1, captureOptions.scale - 0.5);
              }
            }
          }
          
          // Get computed dimensions (without scale factor)
          const rect = element.getBoundingClientRect();
          
          screenshots.push({
            elementId: i,
            elementType: element.tagName,
            imageData: dataUrl,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            format: settings.screenshotFormat,
            scale: captureOptions.scale
          });
          
          capturedElements++;
        } catch (err) {
          console.error('Error capturing element:', err);
          errorElements++;
          
          // Add a placeholder for failed screenshots
          screenshots.push({
            elementId: i,
            elementType: element.tagName,
            error: err.message || 'Failed to capture screenshot',
            width: element.offsetWidth,
            height: element.offsetHeight
          });
        } finally {
          // Restore original element state
          this.restoreElementAfterCapture(element, originalStyles);
          element.classList.add('scraper-selected');
        }
      }
      
      // Send the screenshots back to the popup
      this.browserAPI.runtime.sendMessage({
        type: 'screenshotResult',
        payload: {
          count: screenshots.length,
          successful: capturedElements,
          failed: errorElements,
          screenshots: screenshots
        }
      });
      
    } catch (error) {
      console.error('Screenshot error:', error);
      this.browserAPI.runtime.sendMessage({
        type: 'screenshotResult',
        payload: { error: 'Failed to capture screenshots: ' + error.message }
      });
    }
  }

  // Prepare element for screenshot capture
  prepareElementForCapture(element) {
    // Save original styles/attributes to restore later
    const originalState = {
      lazyImages: [],
      scrollPosition: window.scrollY,
      hasFixedPosition: false,
      originalPosition: '',
      originalZIndex: '',
      originalTransform: ''
    };
    
    // Fix lazy-loaded images
    const lazyImages = element.querySelectorAll('img[loading="lazy"], img[data-src], img[data-srcset]');
    lazyImages.forEach(img => {
      const originalState = {
        loading: img.getAttribute('loading'),
        src: img.getAttribute('src'),
        srcset: img.getAttribute('srcset'),
        sizes: img.getAttribute('sizes'),
        dataSrc: img.getAttribute('data-src'),
        dataSrcset: img.getAttribute('data-srcset'),
        dataSizes: img.getAttribute('data-sizes')
      };
      
      // Store original state
      originalState.lazyImages.push({
        img: img,
        state: originalState
      });
      
      // Force eager loading
      img.setAttribute('loading', 'eager');
      
      // Handle data-src pattern (common in lazy loading libraries)
      if (img.hasAttribute('data-src')) {
        img.setAttribute('src', img.getAttribute('data-src'));
      }
      
      if (img.hasAttribute('data-srcset')) {
        img.setAttribute('srcset', img.getAttribute('data-srcset'));
      }
      
      if (img.hasAttribute('data-sizes')) {
        img.setAttribute('sizes', img.getAttribute('data-sizes'));
      }
    });
    
    // Fix SVG elements
    const svgs = element.querySelectorAll('svg');
    svgs.forEach(svg => {
      // Ensure SVGs have explicit dimensions
      if (!svg.hasAttribute('width') && !svg.hasAttribute('height')) {
        const rect = svg.getBoundingClientRect();
        svg.setAttribute('width', rect.width);
        svg.setAttribute('height', rect.height);
      }
    });
    
    // Handle fixed position elements
    const style = window.getComputedStyle(element);
    if (style.position === 'fixed') {
      originalState.hasFixedPosition = true;
      originalState.originalPosition = element.style.position;
      originalState.originalZIndex = element.style.zIndex;
      originalState.originalTransform = element.style.transform;
      
      // Temporarily convert to absolute positioning
      element.style.position = 'absolute';
      element.style.zIndex = '2147483647'; // Max z-index
      element.style.transform = 'none';
    }
    
    return originalState;
  }

  // Restore element after capture
  restoreElementAfterCapture(element, originalState) {
    // Restore lazy-loaded images
    originalState.lazyImages.forEach(item => {
      const img = item.img;
      const state = item.state;
      
      if (state.loading) {
        img.setAttribute('loading', state.loading);
      } else {
        img.removeAttribute('loading');
      }
      
      if (state.src) {
        img.setAttribute('src', state.src);
      }
      
      if (state.srcset) {
        img.setAttribute('srcset', state.srcset);
      } else {
        img.removeAttribute('srcset');
      }
      
      if (state.sizes) {
        img.setAttribute('sizes', state.sizes);
      } else {
        img.removeAttribute('sizes');
      }
    });
    
    // Restore fixed positioning if needed
    if (originalState.hasFixedPosition) {
      element.style.position = originalState.originalPosition;
      element.style.zIndex = originalState.originalZIndex;
      element.style.transform = originalState.originalTransform;
    }
    
    // Restore scroll position
    window.scrollTo({
      top: originalState.scrollPosition,
      behavior: 'auto'
    });
  }

  injectStyles() {
    if (!this.styleTag) {
      this.styleTag = document.createElement('style');
      this.styleTag.textContent = `
        .scraper-highlight {
          outline: 2px solid #007bff !important;
          background: rgba(0, 123, 255, 0.1) !important;
          cursor: crosshair !important;
        }
        .scraper-selected {
          outline: 3px solid #28a745 !important;
          background: rgba(40, 167, 69, 0.1) !important;
        }
      `;
      document.head.appendChild(this.styleTag);
    }
  }

  cleanup() {
    this.isSelecting = false;
    this.clearHighlights();
    
    // Remove selection styles but keep track of selected elements
    document.querySelectorAll('.scraper-selected').forEach(el => {
      el.classList.remove('scraper-selected');
    });
    
    document.removeEventListener('mouseover', this.handleMouseOver);
    document.removeEventListener('click', this.handleElementSelect);
    document.removeEventListener('keydown', this.handleEscape);
    
    if (this.styleTag) {
      this.styleTag.remove();
      this.styleTag = null;
    }
    
    // Clear selection state in storage
    this.browserAPI.storage.local.set({ selectionState: 'default' });
    
    // Clear the selected elements array
    this.selectedElements = [];
  }

  async retryScreenshot(elementId) {
    try {
      // Check if dom-to-image is loaded
      if (typeof domtoimage !== 'object') {
        this.browserAPI.runtime.sendMessage({
          type: 'screenshotResult',
          payload: { error: 'dom-to-image is not loaded. Please refresh the page and try again.' }
        });
        return;
      }

      // Find the element
      if (elementId < 0 || elementId >= this.selectedElements.length) {
        this.browserAPI.runtime.sendMessage({
          type: 'screenshotResult',
          payload: { error: 'Invalid element ID for retry.' }
        });
        return;
      }

      // Get settings from storage (or use defaults)
      const settings = await this.browserAPI.storage.local.get({
        'screenshotQuality': 0.92,
        'screenshotFormat': 'png',
        'screenshotScale': 1,
        'maxRetries': 2
      });

      // Create progress tracking
      this.browserAPI.runtime.sendMessage({
        type: 'screenshotProgress',
        payload: {
          total: 1,
          completed: 0,
          errors: 0,
          currentElement: 1,
          elementType: this.selectedElements[elementId].tagName
        }
      });

      const element = this.selectedElements[elementId];
      element.classList.remove('scraper-selected');
      const originalStyles = this.prepareElementForCapture(element);

      try {
        // Setup capture options for this specific element
        const captureOptions = {
          bgcolor: null,
          height: element.scrollHeight,
          width: element.scrollWidth,
          style: {
            'transform': 'none',
            'transform-origin': 'center',
          },
          imagePlaceholder: 'data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D\'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg\' width=\'1\' height=\'1\'%3E%3C%2Fsvg%3E',
          quality: settings.screenshotQuality,
          cacheBust: true,
          scale: settings.screenshotScale
        };

        // Capture based on format
        let dataUrl;
        if (settings.screenshotFormat === 'jpeg') {
          dataUrl = await domtoimage.toJpeg(element, captureOptions);
        } else if (settings.screenshotFormat === 'svg') {
          dataUrl = await domtoimage.toSvg(element, captureOptions);
        } else {
          dataUrl = await domtoimage.toPng(element, captureOptions);
        }

        // Get dimensions (without scale factor)
        const rect = element.getBoundingClientRect();

        // Get existing screenshots
        const storage = await this.browserAPI.storage.local.get('screenshots');
        const screenshots = storage.screenshots || [];

        // Replace the screenshot at given index
        const newScreenshot = {
          elementId: elementId,
          elementType: element.tagName,
          imageData: dataUrl,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          format: settings.screenshotFormat,
          scale: captureOptions.scale
        };

        // Find and replace the screenshot
        let found = false;
        for (let i = 0; i < screenshots.length; i++) {
          if (screenshots[i].elementId === elementId) {
            screenshots[i] = newScreenshot;
            found = true;
            break;
          }
        }

        // If not found, add it
        if (!found) {
          screenshots.push(newScreenshot);
        }

        // Save updated screenshots
        await this.browserAPI.storage.local.set({ screenshots });

        // Send success message
        this.browserAPI.runtime.sendMessage({
          type: 'screenshotResult',
          payload: {
            count: screenshots.length,
            successful: 1,
            failed: 0,
            screenshots: screenshots
          }
        });

        // Update progress
        this.browserAPI.runtime.sendMessage({
          type: 'screenshotProgress',
          payload: {
            total: 1,
            completed: 1,
            errors: 0
          }
        });
      } catch (error) {
        console.error('Retry screenshot error:', error);
        this.browserAPI.runtime.sendMessage({
          type: 'screenshotResult',
          payload: { error: 'Failed to retry screenshot: ' + error.message }
        });
      } finally {
        // Restore original element state
        this.restoreElementAfterCapture(element, originalStyles);
        element.classList.add('scraper-selected');
      }
    } catch (error) {
      console.error('Screenshot retry error:', error);
      this.browserAPI.runtime.sendMessage({
        type: 'screenshotResult',
        payload: { error: 'Failed to retry screenshot: ' + error.message }
      });
    }
  }
}

// Initialize the scraper when the content script loads
console.log('Image Scraper content script loaded');
new ElementScraper(); 