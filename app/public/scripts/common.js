// public/scripts/common.js

function showSpinner() {
  document.getElementById('spinner').style.display = 'block';
}

function togglePinVisibility() {
  const pinField = document.getElementById('pin_code');
  const toggleButton = document.querySelector('button[onclick="togglePinVisibility()"]');

  if (pinField.type === "password") {
    pinField.type = "text";
    toggleButton.textContent = "Hide PIN";
  } else {
    pinField.type = "password";
    toggleButton.textContent = "Show PIN";
  }
}

function generateRandomPin() {
  const randomPin = Math.floor(100000 + Math.random() * 900000).toString();
  document.getElementById('pin_code').value = randomPin;
}

let gate = null;

async function fetchNfcKeyAddress() {
  const nfcField = document.getElementById('nfc_key_address');
  const statusText = document.getElementById('statusText');

  const cmd = { name: "get_pkeys" };

  try {
    gate = new HaloGateway('wss://s1.halo-gateway.arx.org');

    // Start pairing and render the QR code
    let pairInfo = await gate.startPairing();
    document.getElementById('qr').src = pairInfo.qrCode;
    document.getElementById('qr').style.display = 'block';

    // Update the NFC key address field to indicate awaiting scan
    nfcField.value = "Awaiting scan for public keys...";
    statusText.innerText = "Please scan the QR code with your smartphone.";

    // Wait for the smartphone to connect
    await gate.waitConnected();
    document.getElementById('qr').style.display = 'none';

    // Execute the get_pkeys command
    statusText.innerText = "Fetching NFC Key Address...";
    const res = await gate.execHaloCmd(cmd);

    // Extract etherAddresses[1] and populate the NFC Key Address field
    const nfcKeyAddress = res.etherAddresses['1'];
    if (nfcKeyAddress) {
      nfcField.value = nfcKeyAddress;
      statusText.innerText = 'NFC Key Address retrieved successfully.';
    } else {
      statusText.innerText = 'Failed to retrieve NFC Key Address.';
    }
  } catch (e) {
    console.error('Failed to fetch NFC key address:', e);
    statusText.innerText = 'Error fetching NFC Key Address. Please try again.';
  }
}