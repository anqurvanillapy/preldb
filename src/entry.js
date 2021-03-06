'use strict'

import fs from 'fs'

const BLOCKSIZE = 512
const ENCODING = 'ascii'

class _PrelDB {
  constructor (fbname, flag = 'c', mode) {
    this._mode = mode

    // The directory file, storing a JSON of the keys and the pairs of the file
    // offest and its value size.
    this._dirfile = fbname + '.dir'

    // The data file, aligned by BLOCKSIZE.
    this._datfile = fbname + '.dat'

    // The backup file.
    this._bakfile = fbname + '.bak'

    // The in-memory mapping that mirrors the directory file.
    this._index = undefined // maps key to a [pos, siz] pair

    // Randomly generated number of remaining operands to commit.
    this._commitCount = 0

    // _commitCount randomly picked from [0, _autoCommitEndpoint].
    this._autoCommitEndpoint = 5

    // Handle the creation
    this._create(flag)
    this._update()
  }

  _create (flag) {
    if (flag === 'n') {
      [this._dirfile, this._datfile, this._bakfile].forEach(f => {
        try { fs.unlinkSync(f) } catch (e) { /* eat errors */ }
      })
    }

    var fd = fs.openSync(this._datfile, 'a+')
    fs.chmodSync(this._datfile, this._mode)
    fs.closeSync(fd)
  }

  // Read the directory to the in-memory index object.
  _update () {
    this._index = {}
    var fd = fs.openSync(this._dirfile, 'a+')
    try {
      this._index = JSON.parse(fs.readFileSync(fd, ENCODING))
    } catch (e) {
      // eat errors
    } finally {
      fs.closeSync(fd)
    }
  }

  // Write the index object to the directory file. The original directory file
  // (if any) is renamed with .bak extension for backup first. If a backup
  // exists, it's deleted.
  _commit () {
    if (typeof this._index === 'undefined') return // it's closed

    try { fs.unlinkSync(this._bakfile) } catch (e) { /* eat errors */ }
    fs.renameSync(this._dirfile, this._bakfile)

    var fd = fs.openSync(this._dirfile, 'w')
    fs.writeSync(fd, `${JSON.stringify(this._index, null, '\t')}\n`, ENCODING)
    fs.chmodSync(this._dirfile, this._mode)
    fs.closeSync(fd)
  }

  sync () { this._commit() }

  _autoCommit () {
    let a = this._autoCommitEndpoint

    if (this._commitCount === 0) {
      this._commitCount = Math.floor(Math.random() * (a + 1))
      this._commit()
    } else {
      this._commitCount--
    }
  }

  set setAutoCommitEndpoint (val) {
    if (val < 1) throw new TypeError('Integer larger than 0 required')
    this._autoCommitEndpoint = val
  }

  _verifyOpen () {
    if (typeof this._index === 'undefined') {
      throw new Error('PrelDB object has been already closed')
    }
  }

  get (key) {
    this._verifyOpen()
    var fd = fs.openSync(this._datfile, 'r')
    var ret = null

    try {
      // Destructuring can raise TypeError if no matches.
      var [pos, siz] = this._index[key]
      var buf = Buffer.alloc(BLOCKSIZE)
      var bytesRead = fs.readSync(fd, buf, 0, siz, pos)
      ret = buf.toString(ENCODING, 0, bytesRead)
    } catch (e) {
      if (!(e instanceof TypeError)) throw e
    } finally {
      fs.closeSync(fd)
    }

    return ret
  }

  // Append val to data file, starting at a BLOCKSIZE-aligned offset. The data
  // file is first padded with NUL bytes (if needed) to get to an aligned
  // offset. Return pair [pos, val.length]
  _addval (val) {
    var pos = fs.statSync(this._datfile)['size']
    var npos = Math.floor((pos + BLOCKSIZE - 1) / BLOCKSIZE) * BLOCKSIZE

    // NOTE: Array(5).join('\0') returns 4 null bytes.
    ;[Array(npos - pos + 1).join('\0'), val].forEach(dat => {
      fs.appendFileSync(this._datfile, dat, ENCODING)
    })

    pos = npos
    return [pos, val.toString().length]
  }

  // Write val to the data file, starting at offset pos. The caller is
  // responsible for ensuring an enough room starting at pos to hold val,
  // without overwriting some other value. Return pair [pos, val.length).
  _setval (pos, val) {
    var fd = fs.openSync(this._datfile, 'r+')
    fs.writeSync(fd, val, pos, ENCODING)
    fs.closeSync(fd)
    return [pos, val.toString().length]
  }

  // key is a new key whose associated value starts in the data file at offset
  // pos with length siz. Add an index record to the in-memory index object, and
  // append one to the directory file.
  _addkey (key, pair) {
    this._index[key] = pair
    var fd = fs.openSync(this._dirfile, 'w')
    fs.chmodSync(this._dirfile, this._mode)
    fs.writeSync(fd, `${JSON.stringify(this._index, null, '\t')}\n`, ENCODING)
  }

  set (key, val) {
    this._verifyOpen()

    if (!(key in this._index)) {
      this._addkey(key, this._addval(val))
    } else {
      var [pos, siz] = this._index[key]
      var [oldblocks, newblocks] = [siz, val.toString().length].map(len => {
        return Math.floor((len + BLOCKSIZE - 1) / BLOCKSIZE)
      })

      if (newblocks <= oldblocks) {
        this._index[key] = this._setval(pos, val)
      } else {
        // The new value doesn't fit in the padded space used by the old value.
        // And the blocks used by the old value are forever lost.
        this._index[key] = this._addval(val)
      }
    }

    this._autoCommit()
  }

  delete (key) {
    this._verifyOpen()
    delete this._index[key]
    this._autoCommit()
  }

  keys () {
    this._verifyOpen()
    return Object.keys(this._index)
  }

  entries () {
    this._verifyOpen()
    return Object.keys(this._index).map(el => { return [el, this._index[el]] })
  }

  contains (key) {
    this._verifyOpen()
    return key in this._index
  }

  get length () {
    return Object.keys(this._index).length
  }

  close () {
    this._commit()
    this._index = this._dirfile = this._datfile = this._bakfile = undefined
  }
}

function open (file, flag = 'c', mode = 0o666) {
  // FIXME: Use process.umask() to check Node's mode
  return new _PrelDB(file, flag, mode)
}

export { open }
