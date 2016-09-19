import fs from 'fs'
import * as babel from 'babel-core'
import deadCodeElimination from 'babel-plugin-minify-dead-code-elimination'
import transformCoverage from './transform-coverage'

export default sliceCode

function sliceCode(coverageData) {
  const {path: filename} = coverageData
  const filteredCoverage = transformCoverage(coverageData)
  // console.log('filteredCoverage', JSON.stringify(filteredCoverage, null, 2))
  const code = fs.readFileSync(filename, 'utf8')
  const sliced = babel.transform(code, {
    filename,
    babelrc: false,
    plugins: [
      getSliceCodeTransform(filteredCoverage),
    ],
  })
  // console.log('sliced', sliced.code)
  const {code: deadCodeEliminated} = babel.transform(sliced.code, {
    filename,
    babelrc: false,
    plugins: [
      deadCodeElimination,
    ],
  })
  // TODO: perf - save time parsing by just transforming the AST from the previous run
  // This will probably significantly speed things up.
  // Unfortunately, when I tried the first time, I couldn't get it working :shrug:
  // console.log('deadCodeEliminated', deadCodeEliminated)
  return deadCodeEliminated
}

function getSliceCodeTransform(filteredCoverage) {
  const fnLocs = getFnLocs(filteredCoverage)
  return function sliceCodeTransform() {
    return {
      visitor: {
        FunctionDeclaration(path) {
          if (!isFunctionCovered(fnLocs, path.node)) {
            removePathAndReferences(path)
          }
        },
        IfStatement(path) {
          const {branchMap} = filteredCoverage
          if (!isBranchCovered(branchMap, path.node)) {
            path.remove()
          }
          path.traverse({
            enter(childPath) {
              const {key, node, parent, parentPath} = childPath
              const otherKey = key === 'consequent' ? 'alternate' : 'consequent'
              if (skipPath()) {
                return
              }
              const sideIsCovered = isBranchSideCovered(branchMap, key, node, parent)
              const otherSideExists = !!path.node[otherKey]
              const otherSideIsCovered = isBranchSideCovered(branchMap, otherKey, node, parent)
              if (isUncoveredAndMissingElse()) {
                handleUncoveredAndMissingElse()
              } else if (hasUncoveredSide()) {
                // console.log('replaceNodeWithNodeFromParent(childPath, otherKey)', childPath, otherKey)
                replaceNodeWithNodeFromParent(childPath, otherKey)
              }

              function skipPath() {
                return parentPath.removed || parentPath !== path || !(key === 'consequent' || key === 'alternate')
              }

              function isUncoveredAndMissingElse() {
                return !sideIsCovered && !otherSideExists
              }

              function handleUncoveredAndMissingElse() {
                if (otherSideIsCovered) {
                  // if (foo) { /* not covered */ } (else-path doesn't exist but is covered) // result: removed
                  // console.log('path.remove()')
                  path.remove()
                } else {
                  // if (foo) { /* not covered */ } // (else-path doesn't exist and isn't covered) // result: ... not sure :shrug:
                  // console.log('childPath.remove()')
                  childPath.remove()
                }
              }

              function hasUncoveredSide() {
                // if (foo) { /* not covered */ } else { /* covered */ } // result: /* covered */
                // if (foo) { /* not covered */ } else { /* not covered */ } // result: removed
                // if (foo) { /* covered */ } (else-path doesn't exist and isn't covered) // result: /* covered */
                // if (foo) { /* covered */ } else { /* not covered */ } // result: ... not sure :shrug:
                return (
                  (!sideIsCovered || !otherSideExists) && !otherSideIsCovered
                ) || !sideIsCovered && otherSideIsCovered
              }
            },
          })
        },
        ConditionalExpression(path) {
          if (path.removed) {
            return
          }
          const {branchMap} = filteredCoverage
          const branchCoverageData = getBranchCoverageData(branchMap, path.node)
          if (!branchCoverageData) {
            path.remove()
            return
          }
          path.traverse({
            enter(childPath) {
              const {key} = childPath
              const otherKey = key === 'consequent' ? 'alternate' : 'consequent'
              if (
                !childPath.removed &&
                childPath.parentPath === path &&
                (key === 'consequent' || key === 'alternate') &&
                !branchCoverageData[key].covered
              ) {
                replaceNodeWithNodeFromParent(childPath, otherKey)
              }
            },
          })
        },
      },
    }
  }
}

function isFunctionCovered(fnLocs, {id: {name}, loc: {start, end}}) {
  return fnLocs[name] &&
    fnLocs[name][start.line] &&
    fnLocs[name][start.line].some(coveredLoc => end.line === coveredLoc.end.line)
}

function getFnLocs({fnMap}) {
  return Object.keys(fnMap).reduce((fnLocs, key) => {
    const {loc, name} = fnMap[key]
    fnLocs[name] = fnLocs[name] || []
    fnLocs[name][loc.start.line] = fnLocs[name][loc.start.line] || []
    fnLocs[name][loc.start.line].push(loc)
    return fnLocs
  }, {})
}

function isBranchCovered(branches, node) {
  const branchCoverageData = getBranchCoverageData(branches, node)
  return !!branchCoverageData
}

function getBranchCoverageData(branches, node) {
  const index = Object.keys(branches).find(key => {
    const branch = branches[key]
    if (branch.type === 'if' && node.type !== 'IfStatement') {
      return false
    } else if (branch.type === 'cond-expr' && node.type !== 'ConditionalExpression') {
      return false
    }
    return isLocationEqual(branch.loc, node.loc)
  })
  return branches[index]
}

function isBranchSideCovered(branches, side, node, parentNode) {
  const branch = getBranchCoverageData(branches, parentNode)
  if (!branch) {
    return false
  }
  return branch[side].covered
}

function isLocationEqual(loc1, loc2) {
  if (!loc1 || !loc2) {
    return false
  }
  return isLineColumnEqual(loc1.start, loc2.start) &&
    isLineColumnEqual(loc1.end, loc2.end)
}

function isLineColumnEqual(obj1, obj2) {
  return obj1.line === obj2.line && obj1.column === obj2.column
}

function replaceNodeWithNodeFromParent(path, key) {
  const {parentPath, parent} = path
  const replacementNode = parent[key] || path.node
  if (parentPath.type === 'IfStatement') {
    // if there are side-effects in the IfStatement, then we need to preserve those
    const typesToPreserve = ['AssignmentExpression', 'CallExpression']
    const nodesToPreserve = []
    parentPath.get('test').traverse({
      enter(testChildPath) {
        if (typesToPreserve.includes(testChildPath.node.type)) {
          nodesToPreserve.push(testChildPath.node)
        }
      },
    })
    parentPath.insertBefore(nodesToPreserve)
  }
  if (replacementNode && replacementNode.body) {
    parentPath.replaceWithMultiple(replacementNode.body)
  } else if (replacementNode) {
    parentPath.replaceWith(replacementNode)
  }
}

function removePathAndReferences(path) {
  path.scope.getBinding(path.node.id.name).referencePaths.forEach(binding => {
    if (binding.parent.type === 'ExportSpecifier') {
      const {parentPath: {parent: {specifiers}}} = binding
      const specifierIndex = specifiers.indexOf(binding.parent)
      if (specifierIndex > -1) {
        specifiers.splice(specifierIndex, 1)
      }
      return
    } else if (binding.parent.type === 'CallExpression') {
      binding.parentPath.parentPath.remove()
      return
    }
    binding.parentPath.remove()
  })
  path.remove()
}