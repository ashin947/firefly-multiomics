/**
 * 渲染进程根组件。
 *
 * 只做一件事：挂路由。全局 Provider（主题 / CssBaseline）在 main.tsx，
 * 这样 App 本身可以被测试直接挂载而不需要再套一层 Provider。
 */
import { RouterProvider } from 'react-router-dom'
import { router } from './router'

export default function App(): JSX.Element {
  return <RouterProvider router={router} />
}
