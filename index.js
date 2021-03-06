const axios = require('axios').default
const bitcoin = require('bitcoinjs-lib')
const sb = require('satoshi-bitcoin')
const request = require('request')
const MIN_RELAY_FEE = 1000
const DEFAULT_SAT_PER_BYTE = 30

function LitecoinSegwitPayments (options) {
  if (!(this instanceof LitecoinSegwitPayments)) return new LitecoinSegwitPayments(options)
  let self = this
  self.options = Object.assign({}, options || {})
  if (!self.options.insightUrl) {
    self.options.insightUrl = 'https://insight.litecore.io/api/'
    console.log('WARN: Using default litecoin block explorer. It is highly suggested you set one yourself!', self.options.insightUrl)
  }
  if (!self.options.feePerKb) {
    self.options.feePerByte = DEFAULT_SAT_PER_BYTE
  }
  if (!self.options.network || (self.options.network === 'mainnet')) {
    if (!self.options.backupBroadcastUrl) {
      self.options.backupBroadcastUrl = 'https://ltc1.trezor.io/api/sendtx/'
    }
  } else if (self.options.network === 'testnet') {
    if (!self.options.backupBroadcastUrl) {
      self.options.backupBroadcastUrl = 'https://ltc1.trezor.io/api/sendtx/'
    }
  } else {
    throw new Error('Invalid network provided ' + self.options.network)
  }
  // if (!self.options.password) throw new Error('LitecoinSegwitPayments: password required')
  return self
}

LitecoinSegwitPayments.prototype.getAddress = function(node, network) {
  const wif = node.toWIF()
  const keyPair = bitcoin.ECPair.fromWIF(wif, network)
  let { address } = bitcoin.payments.p2sh({
    redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey })
  })
  const decoded = bitcoin.address.fromBase58Check(address)
  address = bitcoin.address.toBase58Check(decoded['hash'], 50)
  return address
}

LitecoinSegwitPayments.prototype.getBalance = function(address, options = {}, done) {
  let self = this
  let url = self.options.insightUrl + 'addr/' + address
  request.get({ json: true, url: url }, (err, response, body) => {
    if (!err && response.statusCode !== 200) {
      return done('Unable to get balance from ' + url)
    } else {
      done(null, { balance: body.balance, unconfirmedBalance: body.unconfirmedBalance })
    }
  })
}

LitecoinSegwitPayments.prototype.getUTXOs = function(node, network, done) {
  let self = this
  let address = self.getAddress(node, network)
  //console.log('getting utxos:', address)
  let url = self.options.insightUrl + 'addr/' + address + '/utxo'
  request.get({ json: true, url: url }, function(err, response, body) {
    if (!err && response.statusCode !== 200) {
      return done('Unable to get UTXOs from ' + url)
    } else if (body.length === 0) {
      return done('This address has no unspent outputs ' + url)
    } else {
      let cleanUTXOs = []
      body.forEach(function(utxo) {
        delete utxo['confirmations']
        delete utxo['height']
        delete utxo['ts']
        cleanUTXOs.push(utxo)
      })
      if (self.options.network === 'testnet') {
        console.log('TESTNET ENABLED: Clipping UTXO length to 2 for test purposes')
        cleanUTXOs = cleanUTXOs.slice(0, 2)
      }
      done(null, cleanUTXOs)
    }
  })
}

LitecoinSegwitPayments.prototype.broadcastTransaction = function(txObject, done, retryUrl, originalResponse) {
  let self = this
  let textBody = txObject.signedTx
  let url
  if (retryUrl) url = retryUrl
  else url = 'https://ltc1.trezor.io/api/sendtx/'
  var options = {
    url: url,
    method: 'POST',
    body: textBody
  }
  request(options, function (error, response, body) {
    //console.log('response:', response)
    if (!error && response.statusCode === 200) {
      txObject.broadcasted = true
      done(null, txObject.txid)
    } else {
      if (url !== retryUrl) { // First broadcast attempt. Lets try again.
        self.broadcastTransaction(txObject, done, self.options.backupBroadcastUrl, body)
      } else {
        // Second attempt failed
        done(new Error('unable to broadcast. Some debug info: ' + body.toString() + ' ---- ' + originalResponse.toString()))
      }
    }
  })
}

LitecoinSegwitPayments.prototype.getTransaction = function(node, network, to, amount, utxo, feePerByte) {
  let self = this
  amount = sb.toSatoshi(amount)
  const txb = new bitcoin.TransactionBuilder(network)
  let totalBalance = 0
  if (utxo.length === 0) {
    return new Error('no UTXOs')
  }
  utxo.forEach(function(spendable) {
    totalBalance += spendable.satoshis
    txb.addInput(spendable.txid, spendable.vout) // alice1 unspent
  })
  if (!feePerByte) feePerByte = self.options.feePerByte
  let txfee = estimateTxFee(feePerByte, utxo.length, 1, true)
  if (txfee < MIN_RELAY_FEE) txfee = MIN_RELAY_FEE
  if ((amount - txfee) > totalBalance) return new Error('Balance too small!' + totalBalance + ' ' + txfee)
  txb.addOutput(to, amount - txfee)
  const wif = node.toWIF()
  const keyPair = bitcoin.ECPair.fromWIF(wif, network)
  const p2sh = bitcoin.payments.p2sh({
    redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey })
  })
  for (let i = 0; i < utxo.length; i++) {
    txb.sign(i,
      keyPair,
      p2sh.redeem.output,
      null, // Null for simple Segwit
      utxo[i].satoshis,
      p2sh.redeem.witness
    )
  }
  return { signedTx: txb.build().toHex(), txid: txb.build().getId() }
}

LitecoinSegwitPayments.prototype.transaction = function(node, coin, to, amount, options = {}, done) {
  let self = this
  self.getUTXOs(node, coin.network, (err, utxo) => {
    if (err) return done(err)
    let signedTx = self.getTransaction(node, coin.network, to, amount, utxo, options.feePerByte)
    self.broadcastTransaction(signedTx, done)
  })
}

LitecoinSegwitPayments.prototype.getTxHistory = async function(address, done) {
  let self = this
  try {
    const response = await axios.get(`${self.options.insightUrl}txs`, {
      params: {
        address: address
      }
    })
    const history = response.data.txs.map(tx => {
      const { txid, vout = [{}], vin = [{}], fees, valueIn, valueOut, time } = tx
      return ({ 
        txid: txid, 
        sendAddress: vout[0].addresses ? vout[0].addresses[0] : undefined,
        receiveAddress: vin[0].addr,
        fee: fees,
        amountSent: valueIn,
        amountReceived: valueOut,
        date: time
      })
    })
    return done(null, history)
  } catch (err) {
    return done(`unable to fetch transaction history: ${err}`)
  }
}

/**
* Estimate size of transaction a certain number of inputs and outputs.
* This function is based off of ledger-wallet-webtool/src/TransactionUtils.js#estimateTransactionSize
*/
const estimateTxSize = function(inputsCount, outputsCount, handleSegwit) {
  var maxNoWitness,
    maxSize,
    maxWitness,
    minNoWitness,
    minSize,
    minWitness,
    varintLength
  if (inputsCount < 0xfd) {
    varintLength = 1
  } else if (inputsCount < 0xffff) {
    varintLength = 3
  } else {
    varintLength = 5
  }
  if (handleSegwit) {
    minNoWitness =
    varintLength + 4 + 2 + 59 * inputsCount + 1 + 31 * outputsCount + 4
    maxNoWitness =
    varintLength + 4 + 2 + 59 * inputsCount + 1 + 33 * outputsCount + 4
    minWitness =
    varintLength +
    4 +
    2 +
    59 * inputsCount +
    1 +
    31 * outputsCount +
    4 +
    106 * inputsCount
    maxWitness =
    varintLength +
    4 +
    2 +
    59 * inputsCount +
    1 +
    33 * outputsCount +
    4 +
    108 * inputsCount
    minSize = (minNoWitness * 3 + minWitness) / 4
    maxSize = (maxNoWitness * 3 + maxWitness) / 4
  } else {
    minSize = varintLength + 4 + 146 * inputsCount + 1 + 31 * outputsCount + 4
    maxSize = varintLength + 4 + 148 * inputsCount + 1 + 33 * outputsCount + 4
  }
  return {
    min: minSize,
    max: maxSize
  }
}

function estimateTxFee (satPerByte, inputsCount, outputsCount, handleSegwit) {
  const { min, max } = estimateTxSize(inputsCount, outputsCount, handleSegwit)
  const mean = Math.ceil((min + max) / 2)
  return mean * satPerByte
}

LitecoinSegwitPayments.prototype.getFee = function(node, network, options = {}, done) {
  let self = this
  const feePerByte = options.feePerByte || self.options.feePerByte
  self.getUTXOs(node, network, (err, utxo) => {
    if (!err) {
      return done(null, estimateTxFee(feePerByte, utxo.length, 1, true))
    }
    return done(err)
  })
}

module.exports = LitecoinSegwitPayments
