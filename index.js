'use strict'

const DadiAPI = require('@dadi/api-wrapper')
const FormData = require('form-data')
const fs = require('fs')
const inflection = require('inflection')
const mime = require('mime')
// const marked = require('marked')
const ora = require('ora')
const path = require('path')
const readdirp = require('readdirp')
const visiblePageRe = /^\d+-/

const KirbyMigrator = function (config, directory) {
  this.config = require(path.resolve(config))
  this.directory = path.resolve(directory)
  this.collections = {}
}

KirbyMigrator.prototype.getApi = function () {
  return new DadiAPI({
    uri: this.config.api.host,
    port: this.config.api.port,
    credentials: {
      clientId: this.config.api.clientId,
      secret: this.config.api.secret
    },
    version: this.config.api.version,
    database: this.config.api.database,
    debug: false
  })
}

/**
 * loads content from the specified directory
 */
KirbyMigrator.prototype.load = function () {
  return new Promise((resolve, reject) => {
    this.buildPages(this.directory, []).then(data => {
      return resolve(data)
    })
  })
}

KirbyMigrator.prototype.buildPages = function (thePath, theCollection, depth) {
  return new Promise((resolve, reject) => {
    let options = {
      root: thePath,
      fileFilter: '*.txt',
      depth: depth || 1,
      entryType: 'files',
      lstat: true
    }

    let parents = []

    readdirp(options)
      .on('data', entry => {
        if (entry.fullParentDir !== options.root) {
          if (this.pageKey) {
            if (entry.fullParentDir.indexOf(this.pageKey) > -1) {
              parents.push(entry)
            }
          } else {
            parents.push(entry)
          }
        }
      })
      .on('end', () => {
        if (parents.length === 0) {
          return resolve(theCollection)
        }

        for (let i = 0; i < parents.length; i++) {
          this.buildPage(parents[i]).then(page => {
            if (page) theCollection.push(page)

            if (i === parents.length - 1) {
              return resolve(theCollection)
            }
          })
        }
      })
  })
}

KirbyMigrator.prototype.buildPage = function (entry) {
  return new Promise((resolve, reject) => {
    let key = entry.parentDir
    let directory = entry.fullParentDir
    let isVisible = visiblePageRe.test(key)
    let url = '/' + key.replace(visiblePageRe, '')
    let template = entry.name.replace('.txt', '')

    let page = {
      uid: key,
      attributes: {
        directory: directory,
        template: template,
        visible: isVisible
      },
      url: url,
      children: []
    }

    let raw = fs.readFileSync(entry.fullPath).toString()

    // explode all fields by the line separator
    let fields = raw.split(/\n----\s*\n*/)

    let attributes = {}

    // loop through all fields and add them to the content
    fields.forEach(field => {
      let pos = field.indexOf(':')
      let key = field.substring(0, pos).toLowerCase()
      let value =
        field.substring(pos + 1) === '\n'
          ? null
          : field.substring(pos + 1).trim()

      if (value) {
        attributes[key] = value
      } else {
        attributes[key] = null
      }
    })

    page = Object.assign({}, page, attributes)

    // add images from the same directory
    readdirp({
      root: directory,
      depth: 0,
      entryType: 'files',
      fileFilter: file => {
        return mime.getType(file.fullPath) === 'image/jpeg' ||
          mime.getType(file.fullPath) === 'image/png'
      },
      lstat: false
    }).on('data', file => {
      page.images = page.images || []
      page.images.push(
        file.fullPath.replace(process.cwd(), '')
      )
    })

    return this.buildPages(directory, page.children).then(() => {
      if (page.children.length === 0) {
        delete page.children
      }

      return this.createCollection(page).then(() => {
        return resolve(page)
      })
    })
  })
}

KirbyMigrator.prototype.getCollectionName = function (template) {
  let name = template.replace(/-/g, '_')
  return inflection.camelize(name, true)
}

KirbyMigrator.prototype.createCollection = function (page) {
  return new Promise((resolve, reject) => {
    let collectionName = this.getCollectionName(page.attributes.template)

    // ignores image/media files (templates with extensions)
    if (collectionName.indexOf('.') > 0) return resolve()

    let collection = this.collections[collectionName] || {
      'fields': {},
      'settings': {
        'cache': true,
        'compose': true,
        'cacheTTL': 300,
        'publish': {
          'group': 'Main'
        },
        'authenticate': true,
        'allowExtension': false,
        'callback': null,
        'defaultFilters': {},
        'fieldLimiters': {},
        'storeSearch': false,
        'displayName': inflection.titleize(collectionName),
        'count': 50
      }
    }

    Object.keys(page).forEach(key => {
      let field = Object.assign({}, fieldTemplate)
      field.label = inflection.titleize(key)

      if (typeof page[key] === 'string' && page[key].length > 200) {
        field.publish.multiline = true
      } else {
        field.publish.multiline = false
      }

      if (key === 'order') {
        field.type = 'Number'
        page[key] = parseInt(page[key])
      } else if (key === 'images') {
        field.type = 'Reference'
        field.settings = {
          collection: 'mediaStore'
        }
      } else if (key === 'children') {
        field.type = 'ReferenceAny'
      } else {
        if (page[key] === '1') {
          field.type = 'Boolean'
          page[key] = true
        } else if (page[key] === '0') {
          field.type = 'Boolean'
          page[key] = false
        }
      }

      collection.fields[key] = field
    })

    this.collections[collectionName] = collection
    return resolve()
  })
}

KirbyMigrator.prototype.insertChildren = function (children) {
  return new Promise((resolve, reject) => {
    let queue = []

    children.forEach(thing => {
      let collectionName = this.getCollectionName(thing.attributes.template)

      delete thing.attributes

      if (collectionName.indexOf('.') === -1) {
        queue.push(
          new Promise((resolve, reject) => {
            let imageWait = Promise.resolve([])

            // if (thing.images) {
            //   imageWait = this.insertImages(thing.images)
            // }

            imageWait.then(imageIds => {
              if (imageIds.length === 0) {
                delete thing.images
              } else {
                thing.images = imageIds
              }

              this.getApi()
              .in(collectionName)
              .create(thing)
              .then(results => {
                console.log(results)
                let returnData = results.results.map(item => {
                  item.collection = collectionName
                  return item
                })

                return resolve(returnData)
              })
            })
          })
        )
      }
    })

    Promise.all(queue).then(results => {
      const flatten = list => list.reduce(
        (a, b) => a.concat(Array.isArray(b) ? flatten(b) : b), []
      )

      results = flatten(results)

      let returnData = results.map(item => {
        return {
          collection: item.collection,
          _id: item._id
        }
      })

      return resolve(returnData)
    })
  })
}

KirbyMigrator.prototype.insertImages = function (images) {
  return new Promise((resolve, reject) => {
    let imageIds = []

    images.forEach((image, idx) => {
      const options = {
        host: this.config.api.host.replace('http://', ''),
        port: this.config.api.port,
        path: '/media',
        headers: {
          'Authorization': 'Bearer 8df4a823-1e1e-4bc4-800c-97bb480ccbbe',
          'Accept': 'application/json'
        }
      }

      let uploadResult = ''

      let form = new FormData()
      form.append('file', fs.createReadStream(image))
      form.submit(options, (err, response, body) => {
        if (err) console.log(err)

        response.on('data', chunk => {
          if (chunk) {
            uploadResult += chunk
          }
        })

        response.on('end', () => {
          if (uploadResult) {
            let imageData = JSON.parse(uploadResult)
            imageIds.push(imageData.results[0]._id.toString())
          }

          if (++idx === images.length) {
            return resolve(imageIds)
          }
        })
      })
    })
  })
}

KirbyMigrator.prototype.insertItems = function (data) {
  return new Promise((resolve, reject) => {
    data.forEach(thing => {
      let collectionName = this.getCollectionName(thing.attributes.template)

      if (collectionName.indexOf('.') === -1) {
        let dataSpinner = ora('Inserting data for ' + collectionName + ':' + thing.uid).start()

        delete thing.attributes

        let childrenWait = Promise.resolve([])

        if (thing.children && thing.children.length > 0) {
          childrenWait = this.insertChildren(thing.children)
        }

        childrenWait.then((childIds) => {
          console.log(childIds)
          if (childIds.length === 0) {
            delete thing.children
          } else {
            thing.children = childIds
          }

          let imageWait = Promise.resolve([])

          if (thing.images) {
            imageWait = this.insertImages(thing.images)
          }

          imageWait.then(imageIds => {
            if (imageIds.length === 0) {
              delete thing.images
            } else {
              thing.images = imageIds
            }

            this.getApi()
            .in(collectionName)
            .create(thing)
            .then(response => {
              if (response.results && response.results.length > 0) {
                // console.log(response.results)
                dataSpinner.succeed()
                return resolve(response.results)
              }
            }).catch(err => {
              dataSpinner.fail(`Error inserting into collection ${collectionName}: ${err.statusCode}`)
            })
          })
        })
      }
    })
  })
}

let args = process.argv

if (args.length < 4) {
  process.exit(0)
}

const migrator = new KirbyMigrator(args[2], args[3])

console.log(migrator)

let spinner = ora('Loading unicorns').start()

migrator.load().then(data => {
  spinner.succeed()

  // console.log(data)
  // data.forEach(thing => {
  //   if (thing.uid === '9-moskito-island') {
  //     fs.writeFile('data.json', JSON.stringify(thing, null, 2), err => {
  //     })
  //   }
  // })

  let queue = []

  let collectionsSpinner = ora('Creating collections').start()

  Object.keys(migrator.collections).forEach(collection => {
    queue.push(new Promise((resolve, reject) => {
      let collectionSpinner = ora('Creating collection ' + collection).start()

      const schema = migrator.collections[collection]
      delete schema.fields.attributes

      // create or update collection schema config
      migrator.getApi()
      .in(collection)
      .setConfig(schema)
      .then(response => {
        // console.log(response)
        collectionSpinner.succeed('Created collection ' + collection)
        return resolve()
        // if (response.results && response.results.length > 0) {
        //   response.results.forEach(result => {
        //   })
        // }
      }).catch(err => {
        collectionSpinner.fail(`Error creating collection ${collection}: ${err.statusCode}`)
      })
    }))
  })

  Promise.all(queue).then(() => {
    collectionsSpinner.succeed('Created collections')

    // insert data
    let dataSpinner = ora('Inserting data').start()
    migrator.insertItems(data).then(() => {
      dataSpinner.succeed()
    })
  })
})

const fieldTemplate = {
  'type': 'String',
  'label': '',

  'required': false,
  'publish': {
    'section': 'Main',
    'placement': 'main',
    // "group": "Main",
    'multiline': false,
    'display': {
      'edit': true,
      'list': true
    }
  }
}
