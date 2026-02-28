
function goToStoreForUpdate() {
    const updateLink = "ms-windows-store://updates";
    if (window.require) {
        require('electron').shell.openExternal(updateLink);
    } else {
        window.open(updateLink, '_blank');
    }
}
// Function to launch the Microsoft Store Rating window
function launchStoreRating() {
    const productId = "9P2CHLWQG9VL"; // Your official Store ID
    const reviewUrl = `ms-windows-store://review/?ProductId=${productId}`;
    
    // Use Electron's shell to open the protocol
    if (window.require) {
        const { shell } = window.require('electron');
        shell.openExternal(reviewUrl);
    } else {
        window.open(reviewUrl, '_blank');
    }
    
    // Mark as rated so we don't ask again
    localStorage.setItem('hasRatedApp', 'true');
    closeRatingModal();
}

// Logic to decide WHEN to show the rating prompt
function checkRatingTrigger() {
    const hasRated = localStorage.getItem('hasRatedApp');
    if (hasRated === 'true') return;

    let actionCount = parseInt(localStorage.getItem('successfulActions') || '0');
    actionCount++;
    localStorage.setItem('successfulActions', actionCount);

    // Ask on the 3rd successful note save
    if (actionCount === 8) {
        showRatingModal();
    }
}
function showRatingModal() {
        document.getElementById('ratingModal').classList.remove('hidden');
    }
    function closeRatingModal() {
        document.getElementById('ratingModal').classList.add('hidden');
    }
// Run check 5 seconds after app starts
