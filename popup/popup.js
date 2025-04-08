class ScraperUI {
  constructor() {
    this.status = 'idle';
    this.currentTab = null;
    this.selectedElement = null;
    this.scrapedImages = [];
    this.isSelecting = false;
    this.settings = {
      threshold: 100, // Minimum image dimension (width/height)
      downloadType: 'all', // 'all', 'selected', or 'filtered'
      quality: 0.8, // For screenshots
      format: 'png' // For screenshots
    };

    // Set up browser API compatibility
    this.browserAPI = typeof browser !== 'undefined' ? browser : chrome;

    // Initialize UI elements
    this.statusBadge = document.getElementById('status');
    this.selectBtn = document.getElementById('selectElement');
    this.scrapeBtn = document.getElementById('scrapeImages');
    this.screenshotBtn = document.getElementById('captureScreenshot');
    this.cancelBtn = document.getElementById('cancelAction');
    this.resultsContainer = document.getElementById('results-container');
    this.themeToggle = document.getElementById('themeToggle');
    this.downloadAllBtn = document.getElementById('downloadAll');
    
    // Initialize the UI
    this.init();
    
    // Setup message listener for background script communication
    window.addEventListener('message', this.handlePostMessage.bind(this));
  }

  async init() {
    try {
      // Set up event listeners
      this.selectBtn.addEventListener('click', () => this.startElementSelection());
      this.scrapeBtn.addEventListener('click', () => this.scrapeImages());
      this.screenshotBtn.addEventListener('click', () => this.captureScreenshot());
      this.cancelBtn.addEventListener('click', () => this.cancelAction());
      this.themeToggle.addEventListener('change', () => this.toggleTheme());
      this.downloadAllBtn.addEventListener('click', () => this.downloadAllImages());
      
      // Get current theme from storage and apply it
      this.loadTheme();
      
      // Get the current tab
      const tabs = await this.browserAPI.tabs.query({ active: true, currentWindow: true });
      this.currentTab = tabs[0];
      
      // Check if we can run scripts on this tab
      if (!this.canExecuteScripts(this.currentTab.url)) {
        this.updateStatus('error', 'Cannot run on this page');
        this.disableActions();
        return;
      }
      
      // Check saved selection state
      const savedState = await this.browserAPI.storage.local.get([
        'selectionState', 
        'tabId', 
        'selectedElements',
        'hasSelectedElements'
      ]);
      
      const isSelecting = savedState.selectionState === 'selecting' && savedState.tabId === this.currentTab.id;
      const hasSelectedElements = savedState.hasSelectedElements && savedState.tabId === this.currentTab.id;
      
      console.log('Saved state:', savedState);
      
      if (hasSelectedElements) {
        this.selectedElement = true; // Just need a truthy value to enable buttons
        this.updateStatus('ready', 'Elements selected');
        this.scrapeBtn.disabled = false;
        this.screenshotBtn.disabled = false;
        this.cancelBtn.disabled = false;
      }
      
      // Check if content script is already active
      try {
        const response = await this.browserAPI.tabs.sendMessage(this.currentTab.id, { 
          action: 'getSelectionState' 
        });
        
        console.log('Content script status:', response);
        
        if (response && response.status === 'success') {
          // Update UI based on selection state
          if (response.isSelecting) {
            this.updateStatus('selecting', 'Continue selecting');
            this.cancelBtn.disabled = false;
          } else if (response.hasSelectedElement) {
            // This explicitly sets the selectedElement property to enable buttons
            this.selectedElement = true;
            this.updateStatus('ready', 'Elements selected');
            this.scrapeBtn.disabled = false;
            this.screenshotBtn.disabled = false;
            this.cancelBtn.disabled = false;
            
            // Save this state
            await this.browserAPI.storage.local.set({
              hasSelectedElements: true,
              tabId: this.currentTab.id
            });
          }
        }
      } catch (error) {
        console.log('Injecting content script...', error);
        try {
          if (this.browserAPI.scripting) {
            // Manifest V3 approach
            await this.browserAPI.scripting.executeScript({
              target: { tabId: this.currentTab.id },
              files: ['/content_scripts/content.js']
            });
          } else {
            // Fallback for Firefox which might not support scripting API
            await this.browserAPI.tabs.executeScript({
              file: '/content_scripts/content.js'
            });
          }
          
          // If we were in selection mode, restore it
          if (isSelecting) {
            // Wait a moment for content script to initialize
            setTimeout(async () => {
              await this.browserAPI.tabs.sendMessage(this.currentTab.id, {
                action: 'startSelection'
              });
              this.updateStatus('selecting', 'Continue selecting');
              this.cancelBtn.disabled = false;
            }, 500);
          }
        } catch (scriptingError) {
          console.error('Failed to inject content script:', scriptingError);
          this.updateStatus('error', 'Failed to load content script');
        }
      }
      
      // Load saved settings
      this.loadSettings();
      
      // Set initial status if not already set
      if (this.status === 'idle') {
        this.updateStatus('ready', 'Ready');
      }
      
      // Listen for messages from content script
      this.browserAPI.runtime.onMessage.addListener(this.handleMessage.bind(this));

      // Check stored selection count
      const storage = await this.browserAPI.storage.local.get([
        'selectedElementsCount',
        'hasSelectedElements'
      ]);
      
      if (storage.hasSelectedElements && storage.selectedElementsCount > 0) {
        this.scrapeBtn.disabled = false;
        this.screenshotBtn.disabled = false;
        this.updateStatus('ready', `${storage.selectedElementsCount} elements selected`);
      }
    } catch (error) {
      console.error('Initialization error:', error);
      this.updateStatus('error', 'Error initializing');
    }
  }
  
  // Theme management
  loadTheme() {
    this.browserAPI.storage.local.get('theme').then(({ theme }) => {
      if (theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.setAttribute('data-theme', 'dark');
        this.themeToggle.checked = true;
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        this.themeToggle.checked = false;
      }
    }).catch(() => {
      // Default to system preference if not set
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      this.themeToggle.checked = prefersDark;
    });
    
    // Listen for system theme changes if set to auto
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      this.browserAPI.storage.local.get('theme').then(({ theme }) => {
        if (theme === 'auto') {
          document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
          this.themeToggle.checked = e.matches;
        }
      });
    });
  }
  
  toggleTheme() {
    const isDark = this.themeToggle.checked;
    const theme = isDark ? 'dark' : 'light';
    
    document.documentElement.setAttribute('data-theme', theme);
    this.browserAPI.storage.local.set({ theme });
    
    // Show toast notification
    this.showToast(`${isDark ? 'Dark' : 'Light'} mode activated`, 'info');
  }
  
  showToast(message, type = 'info', duration = 3000) {
    // Remove any existing toast
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
      existingToast.remove();
    }
    
    // Create and show new toast
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    // Remove after duration
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(100%)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // UI status updates
  updateStatus(type, message) {
    this.status = type;
    this.statusBadge.textContent = message;
    this.statusBadge.className = 'status-badge';
    
    // Add appropriate class based on status type
    if (type === 'ready') {
      this.statusBadge.classList.add('success');
    } else if (type === 'selecting' || type === 'scraping' || type === 'capturing') {
      this.statusBadge.classList.add('active');
    } else if (type === 'error') {
      this.statusBadge.classList.add('error');
    } else if (type === 'warning') {
      this.statusBadge.classList.add('warning');
    }
    
    // Update button states based on status
    this.updateButtonStates();
  }
  
  updateButtonStates() {
    // Default state - all disabled
    this.selectBtn.disabled = true;
    this.scrapeBtn.disabled = true;
    this.screenshotBtn.disabled = true;
    this.cancelBtn.disabled = true;
    
    // Enable buttons based on current state
    const canRunOnPage = this.canExecuteScripts(this.currentTab?.url);
    
    switch (this.status) {
      case 'ready':
        // In ready state, can select elements
        this.selectBtn.disabled = !canRunOnPage;
        
        // Check if we have selected elements
        if (this.selectedElement || (this.scrapedImages && this.scrapedImages.length > 0)) {
          this.scrapeBtn.disabled = !canRunOnPage;
          this.screenshotBtn.disabled = !canRunOnPage;
        }
        break;
        
      case 'selecting':
        // During selection, can only cancel
        this.cancelBtn.disabled = false;
        break;
        
      case 'scraping':
      case 'capturing':
        // During active operations, can only cancel
        this.cancelBtn.disabled = false;
        break;
        
      case 'error':
      case 'idle':
        // After error or when idle, can try selecting again
        this.selectBtn.disabled = !canRunOnPage;
        break;
    }
  }
  
  disableActions() {
    this.selectBtn.disabled = true;
    this.scrapeBtn.disabled = true;
    this.screenshotBtn.disabled = true;
    this.cancelBtn.disabled = true;
  }
  
  canExecuteScripts(url) {
    return url.startsWith('http://') || 
           url.startsWith('https://') || 
           url.startsWith('file://');
  }

  // Start element selection mode
  async startElementSelection() {
    try {
      this.updateStatus('selecting', 'Select element');
      
      // Save current state to storage before popup closes
      await this.browserAPI.storage.local.set({
        selectionState: 'selecting',
        tabId: this.currentTab.id
      });
      
      // Send message to content script to start selection
      await this.browserAPI.tabs.sendMessage(this.currentTab.id, {
        action: 'startSelection'
      });
      
      // Show instructions toast before closing
      this.showToast('Popup will close. Select elements on page, then click extension icon again to continue.', 'info', 2000);
      
      // Wait a moment for the toast to be visible
      setTimeout(() => {
        // Minimize popup window to see the page better
        window.blur();
      }, 2000);
    } catch (error) {
      console.error('Selection error:', error);
      this.updateStatus('error', 'Selection failed');
      this.showToast('Failed to start selection mode', 'error');
    }
  }

  // Scrape images from the page
  async scrapeImages() {
    try {
      this.updateStatus('scraping', 'Scraping...');
      this.resultsContainer.innerHTML = '';
      
      // Store a flag to indicate we're scraping
      await this.browserAPI.storage.local.set({
        selectionState: 'scraping',
        tabId: this.currentTab.id
      });
      
      // Send message to content script to scrape images
      await this.browserAPI.tabs.sendMessage(this.currentTab.id, {
        action: 'scrapeImages',
        settings: this.settings
      });
      
      // Show toast notification
      this.showToast('Scraping images... popup may close but will continue in background', 'info');
    } catch (error) {
      console.error('Scraping error:', error);
      this.updateStatus('error', 'Scraping failed');
      this.showToast('Failed to scrape images: ' + error.message, 'error');
      
      // Reset state
      await this.browserAPI.storage.local.set({
        selectionState: 'default',
        tabId: null
      });
    }
  }

  // Capture screenshot of visible area or specific element
  async captureScreenshot() {
    try {
      this.updateStatus('capturing', 'Capturing...');
      this.resultsContainer.innerHTML = '';
      
      // Store a flag to indicate we're capturing
      await this.browserAPI.storage.local.set({
        selectionState: 'capturing',
        tabId: this.currentTab.id
      });
      
      // First try to use the content script for element screenshots
      await this.browserAPI.tabs.sendMessage(this.currentTab.id, {
        action: 'captureScreenshot'
      });
      
      // Show toast notification
      this.showToast('Taking screenshots... popup may close but will continue in background', 'info');
    } catch (error) {
      console.error('Screenshot error:', error);
      
      // If content script approach fails, try capturing the entire visible tab
      try {
        const captureData = await this.browserAPI.tabs.captureVisibleTab(null, {
          format: this.settings.format || 'png',
          quality: this.settings.quality ? this.settings.quality * 100 : 80
        });
        
        // Display the screenshot
        this.displayScreenshot(captureData);
        
        // Update status
        this.updateStatus('ready', 'Screenshot captured');
        this.showToast('Screenshot captured successfully', 'success');
      } catch (fallbackError) {
        console.error('Fallback screenshot error:', fallbackError);
        this.updateStatus('error', 'Capture failed');
        this.showToast('Failed to capture screenshot: ' + fallbackError.message, 'error');
        
        // Reset state
        await this.browserAPI.storage.local.set({
          selectionState: 'default',
          tabId: null
        });
      }
    }
  }

  // Cancel current action
  async cancelAction() {
    try {
      if (this.status === 'selecting') {
        await this.browserAPI.tabs.sendMessage(this.currentTab.id, {
          action: 'cancelActions'  // Changed from 'cancelSelection' to match content.js
        });
      } else if (this.status === 'scraping') {
        await this.browserAPI.tabs.sendMessage(this.currentTab.id, {
          action: 'cancelActions'  // Changed from 'cancelScraping' to match content.js
        });
      } else if (this.status === 'capturing') {
        // Cancel screenshot capture
        // Currently, there's no built-in way to cancel screenshots
      }
      
      // Reset the selection state
      this.selectedElement = false;
      
      // Reset the selection state in storage
      await this.browserAPI.storage.local.set({
        selectionState: 'default',
        tabId: null,
        hasSelectedElements: false,
        selectedElementsCount: 0
      });
      
      this.updateStatus('ready', 'Ready');
      this.showToast('Action cancelled', 'info');
    } catch (error) {
      console.error('Cancel error:', error);
      this.updateStatus('error', 'Failed to cancel');
      this.showToast('Failed to cancel action', 'error');
    }
  }

  // Display screenshot in the results container
  displayScreenshot(imageData) {
    const container = document.createElement('div');
    container.className = 'result-item';
    
    const img = document.createElement('img');
    img.src = imageData;
    img.alt = 'Screenshot';
    
    container.appendChild(img);
    container.addEventListener('click', () => this.saveImage(imageData, 'screenshot'));
    
    this.resultsContainer.appendChild(container);
  }

  // Display scraped images in the results container
  displayImages(images) {
    this.resultsContainer.innerHTML = '';
    this.downloadAllBtn.disabled = images.length === 0;
    
    images.forEach((imageData, index) => {
      const container = document.createElement('div');
      container.className = 'result-item';
      
      const imgWrapper = document.createElement('div');
      imgWrapper.style.position = 'relative';
      
      const img = document.createElement('img');
      img.src = imageData.src;
      img.alt = `Image ${index + 1}`;
      
      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'download-btn';
      downloadBtn.innerHTML = '<i class="ri-download-line"></i>';
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.saveImage(imageData.src, 'image');
      });

      imgWrapper.appendChild(img);
      imgWrapper.appendChild(downloadBtn);
      container.appendChild(imgWrapper);
      this.resultsContainer.appendChild(container);
    });
  }

  // Save an image to disk
  async saveImage(src, type) {
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = this.generateFilename(type);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.showToast('Download started', 'success');
    } catch (error) {
      console.error('Download error:', error);
      this.showToast('Failed to download image', 'error');
    }
  }

  // Generate a filename for downloaded images
  generateFilename(type) {
    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const tabTitle = this.currentTab?.title?.replace(/[/\\?%*:|"<>]/g, '-') || 'image';
    
    return `${type}_${tabTitle}_${timestamp}.${this.settings.format || 'png'}`;
  }

  // Load settings from storage
  async loadSettings() {
    try {
      const data = await this.browserAPI.storage.local.get('scraperSettings');
      if (data.scraperSettings) {
        this.settings = { ...this.settings, ...data.scraperSettings };
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  // Save settings to storage
  async saveSettings() {
    try {
      await this.browserAPI.storage.local.set({
        scraperSettings: this.settings
      });
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  // Handle messages from content script
  handleMessage(message, sender, sendResponse) {
    console.log('Popup received message:', message);
    
    if (sender.tab && sender.tab.id !== this.currentTab.id) {
      return; // Ignore messages from other tabs
    }
    
    // Handle message types from the content script
    if (message.type === 'selectionUpdate') {
      const payload = message.payload;
      if (payload.selected) {
        this.selectedElement = true; // Set this explicitly to enable buttons
        this.updateStatus('ready', `Selected ${payload.elementCount} element(s)`);
        this.scrapeBtn.disabled = false;
        this.screenshotBtn.disabled = false;
        this.cancelBtn.disabled = false;
        
        // Save this state to storage for persistence
        this.browserAPI.storage.local.set({
          hasSelectedElements: true,
          selectedElementsCount: payload.elementCount,
          tabId: this.currentTab.id
        });
      } else {
        this.selectedElement = false;
        this.updateStatus('selecting', 'Selecting...');
      }
      return;
    }
    
    if (message.type === 'scrapeResult') {
      if (message.payload.error) {
        this.updateStatus('error', 'Scraping failed');
        this.showToast(message.payload.error, 'error');
      } else {
        this.scrapedImages = this.processScrapedImages(message.payload);
        this.displayImages(this.scrapedImages);
        this.updateStatus('ready', `Found ${this.scrapedImages.length} images`);
        this.showToast(`Found ${this.scrapedImages.length} images`, 'success');
      }
      return;
    }
    
    if (message.type === 'screenshotResult') {
      if (message.payload.error) {
        this.updateStatus('error', 'Screenshot failed');
        this.showToast(message.payload.error, 'error');
      } else {
        this.displayScreenshotResults(message.payload);
        this.updateStatus('ready', 'Screenshot captured');
        this.showToast('Screenshot captured successfully', 'success');
      }
      return;
    }
    
    if (message.type === 'screenshotProgress') {
      const progress = Math.round((message.payload.completed / message.payload.total) * 100);
      this.updateStatus('capturing', `Capturing ${progress}%`);
      return;
    }
    
    // Handle action-based messages (legacy format)
    switch (message.action) {
      case 'selectionStarted':
        this.updateStatus('selecting', 'Selecting...');
        break;
        
      case 'selectionCancelled':
        this.updateStatus('ready', 'Selection cancelled');
        this.showToast('Selection cancelled', 'info');
        break;
        
      case 'elementSelected':
        this.selectedElement = message.data;
        this.updateStatus('ready', 'Element selected');
        this.showToast('Element selected successfully', 'success');
        break;
        
      case 'scrapingStarted':
        this.updateStatus('scraping', 'Scraping...');
        break;
        
      case 'scrapingProgress':
        this.updateStatus('scraping', `Scraping ${message.current}/${message.total}`);
        break;
        
      case 'scrapingComplete':
        this.scrapedImages = message.images;
        this.displayImages(message.images);
        this.updateStatus('ready', `Found ${message.images.length} images`);
        this.showToast(`Found ${message.images.length} images`, 'success');
        break;
        
      case 'scrapingError':
        this.updateStatus('error', 'Scraping failed');
        this.showToast(message.error || 'Failed to scrape images', 'error');
        break;
        
      case 'captureComplete':
        this.displayScreenshot(message.imageData);
        this.updateStatus('ready', 'Screenshot captured');
        break;
    }
  }
  
  // Process scraped images from response
  processScrapedImages(payload) {
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
  
  // Display screenshot results
  displayScreenshotResults(payload) {
    this.resultsContainer.innerHTML = ''; // Clear previous results
    this.downloadAllBtn.disabled = !payload.screenshots || payload.screenshots.length === 0; // Enable/disable bulk download

    if (payload.screenshots && Array.isArray(payload.screenshots)) {
      payload.screenshots.forEach((screenshot, index) => {
        if (screenshot.imageData) {
          const container = document.createElement('div');
          container.className = 'result-item';
          
          const imgWrapper = document.createElement('div');
          imgWrapper.style.position = 'relative';
          
          const img = document.createElement('img');
          img.src = screenshot.imageData;
          img.alt = `Screenshot ${index + 1}`;
          
          const downloadBtn = document.createElement('button');
          downloadBtn.className = 'download-btn';
          downloadBtn.innerHTML = '<i class="ri-download-line"></i>';
          downloadBtn.title = 'Download Screenshot'; // Add title for clarity
          downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent triggering other clicks if needed
            this.saveImage(screenshot.imageData, 'screenshot');
          });

          imgWrapper.appendChild(img);
          imgWrapper.appendChild(downloadBtn);
          container.appendChild(imgWrapper);
          this.resultsContainer.appendChild(container);
          
          // Add screenshot data to scrapedImages for potential bulk download
          // Check if it's already added to avoid duplicates
          if (!this.scrapedImages.some(item => item.src === screenshot.imageData)) {
             this.scrapedImages.push({ src: screenshot.imageData, type: 'screenshot' });
          }

        } else if (screenshot.error) {
           // Optionally display an error placeholder for failed screenshots
           const errorContainer = document.createElement('div');
           errorContainer.className = 'result-item error-placeholder'; // Add specific class
           errorContainer.textContent = `Error capturing element ${index + 1}: ${screenshot.error}`;
           this.resultsContainer.appendChild(errorContainer);
        }
      });

       // Update bulk download button state after processing all screenshots
       this.downloadAllBtn.disabled = this.scrapedImages.length === 0;

    } else if (payload.error) {
       // Handle overall screenshot error if needed
       console.error("Screenshot result error:", payload.error);
    }
  }

  // Handle postMessage events from background script
  handlePostMessage(event) {
    // Verify origin and message structure
    if (event.source !== window || !event.data || event.data.source !== 'background') {
      return;
    }
    
    console.log('Popup received postMessage:', event.data);
    
    // Process the message from background
    if (event.data.payload) {
      this.handleMessage(event.data.payload, { tab: { id: this.currentTab?.id } });
    }
  }

  // Add new method for bulk download
  async downloadAllImages() {
    // Check if JSZip is loaded
    if (typeof JSZip === 'undefined') {
      console.error('JSZip library is not loaded.');
      // Add more verbose debugging info
      console.log('Attempting to load JSZip dynamically...');
      
      try {
        // Try to dynamically load JSZip if it's not already loaded
        const script = document.createElement('script');
        script.src = '../lib/jszip.min.js';
        script.onload = () => {
          console.log('JSZip loaded successfully. Please try downloading again.');
          this.showToast('JSZip loaded! Try downloading again.', 'info');
        };
        script.onerror = (e) => {
          console.error('Failed to load JSZip dynamically:', e);
          this.showToast('Error: Could not load JSZip library. Check console for details.', 'error');
        };
        document.head.appendChild(script);
        return;
      } catch (loadError) {
        console.error('Error attempting to load JSZip:', loadError);
        this.showToast('Error: Download library missing or inaccessible.', 'error');
        return;
      }
    }

    try {
      const imagesToDownload = this.scrapedImages.filter(img => img && img.src); // Filter out invalid entries
      
      if (!imagesToDownload || imagesToDownload.length === 0) {
        this.showToast('No valid images to download', 'warning');
        return;
      }

      this.showToast(`Preparing ${imagesToDownload.length} images for download...`, 'info');

      const zip = new JSZip();
      const folder = zip.folder("scraped_images");
      let fetchErrors = 0;

      // Add all images to zip
      await Promise.all(imagesToDownload.map(async (img, index) => {
        try {
          console.log(`Fetching image ${index + 1}: ${img.src}`); // Log URL
          const response = await fetch(img.src);
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          const blob = await response.blob();
          // Generate a safe filename (replace invalid characters)
          const filename = `image_${index + 1}.${blob.type.split('/')[1] || 'png'}`; 
          folder.file(filename.replace(/[/\\?%*:|"<>]/g, '-'), blob);
        } catch (fetchError) {
          fetchErrors++;
          console.error(`Failed to fetch image ${index + 1} (${img.src}):`, fetchError);
          // Optionally add a placeholder or skip the file
        }
      }));

      if (fetchErrors > 0) {
         this.showToast(`Warning: ${fetchErrors} image(s) failed to download.`, 'warning', 5000);
      }
      
      if (fetchErrors === imagesToDownload.length) {
          this.showToast('Error: All images failed to download.', 'error');
          return; // Don't generate zip if all failed
      }

      // Generate zip file
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      
      // Trigger download
      const a = document.createElement('a');
      a.href = url;
      // Generate a timestamped zip filename
      const zipFilename = `scraped_images_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
      a.download = zipFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url); // Clean up blob URL
      
      this.showToast(`Downloaded ${imagesToDownload.length - fetchErrors} images as ${zipFilename}`, 'success');

    } catch (error) {
      console.error('Bulk download process error:', error);
      // Provide more specific error if possible
      this.showToast(`Error creating ZIP: ${error.message || 'Unknown error'}`, 'error');
    }
  }
}

// Initialize the UI when the document is loaded
document.addEventListener('DOMContentLoaded', () => {
  new ScraperUI();
}); 