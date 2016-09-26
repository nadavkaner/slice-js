import {runAllCombosTests, comboOfBools} from './helpers/utils'

// fit(
//   'ifWithFunctionCall(false)',
//   require('./helpers/utils').snapSlice(require.resolve('./fixtures/if-statement-side-effects'), ({ifWithFunctionCall}) => {
//     return [
//       ifWithFunctionCall(false),
//     ]
//   })
// )


runAllCombosTests({
  filename: require.resolve('./fixtures/if-statement-side-effects'),
  methods: [
    {methodName: 'ifWithAssignment', possibleArguments: comboOfBools(1)},
    {methodName: 'ifWithFunctionCall', possibleArguments: comboOfBools(1)},
  ],
})
