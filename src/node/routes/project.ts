import { exec } from "child_process"
import { Router } from "express"
import { promises as fs } from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { HttpCode, HttpError } from "../../common/http"
import { ensureAuthenticated } from "../http"
import { paths } from "../util"

const execAsync = promisify(exec)

// Cache for socket connections by projectId
const clientCache = new Map<string, net.Socket>()

export const router = Router()

// Middleware to handle CORS for all project routes
router.use((req, res, next) => {
  // Set CORS headers for all routes
  res.setHeader("Access-Control-Allow-Origin", "https://localhost:3000")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Code-Server-Session")
  res.setHeader("Access-Control-Allow-Credentials", "true")

  // Handle OPTIONS requests immediately (CORS preflight)
  if (req.method === "OPTIONS") {
    res.status(204).send()
    return
  }

  next()
})

const VALID_FRAMEWORKS = ["basic-html", "vite-vanilla", "vite-vue", "vite-react", "nextjs"]
const PROJECTS_DIR = path.join(paths.data, "projects")
const SCAFFOLDING_REPO_URL = process.env.SCAFFOLDING_REPO_URL || "git@github.com:bojie-liu/ai-hub-scaffolding-app.git"

interface InitProjectRequest {
  projectId: string
  framework: string
  filePath?: string // unused, kept for API compatibility
}

interface SaveProjectRequest {
  projectId: string
}

interface DeployProjectRequest {
  projectId: string
  version: string
}

interface ExecuteCommandRequest {
  projectId: string
  commandJson: string
}

/**
 * POST /project/init
 * Initialize a new project from a framework template with git repository
 */
router.post("/init", ensureAuthenticated, async (req, res) => {
  try {
    const { projectId, framework } = req.body as InitProjectRequest

    // Validation
    if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
      throw new HttpError("projectId is required and must be a non-empty string", HttpCode.BadRequest)
    }

    // Validate projectId format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9-_]+$/.test(projectId)) {
      throw new HttpError(
        "projectId must contain only alphanumeric characters, hyphens, and underscores",
        HttpCode.BadRequest,
      )
    }

    if (!framework || !VALID_FRAMEWORKS.includes(framework)) {
      throw new HttpError(`framework must be one of: ${VALID_FRAMEWORKS.join(", ")}`, HttpCode.BadRequest)
    }

    const projectPath = path.join(PROJECTS_DIR, projectId)
    console.log("Initializing project at", projectPath)

    // Check if project already exists
    try {
      await fs.access(projectPath)
      console.log("Project already exists at", projectPath)
      throw new HttpError(`Project '${projectId}' already exists`, HttpCode.BadRequest)
    } catch (err: any) {
      console.log("Project does not exist, proceeding to create", err)
      if (err instanceof HttpError) throw err
      if (err.code !== "ENOENT") throw err
    }

    console.log("josh finish mkdir projects dir")
    // Create projects directory if it doesn't exist
    const result = await fs.mkdir(PROJECTS_DIR, { recursive: true })
    console.log("josh finish mkdir projects dir success", result)

    // Clone scaffolding repository
    try {
      console.log(`Cloning repository from ${SCAFFOLDING_REPO_URL} to ${projectPath}`)
      await execAsync(`git clone ${SCAFFOLDING_REPO_URL} -b ${framework} "${projectPath}"`)
    } catch (err: any) {
      // Clean up project directory if git clone fails
      await fs.rm(projectPath, { recursive: true, force: true })
      throw new HttpError(`Failed to clone repository: ${err.message}`, HttpCode.ServerError)
    }

    // Checkout to a new branch with the project ID
    try {
      await execAsync(`git checkout -b ${projectId}`, { cwd: projectPath })
    } catch (err: any) {
      // Clean up project directory if git checkout fails
      await fs.rm(projectPath, { recursive: true, force: true })
      throw new HttpError(`Failed to create branch: ${err.message}`, HttpCode.ServerError)
    }

    res.json({
      success: true,
      projectId: projectId,
      projectPath,
      framework,
    })
  } catch (err: any) {
    if (err instanceof HttpError) {
      throw err
    }
    throw new HttpError(`Failed to initialize project: ${err.message}`, HttpCode.ServerError)
  }
})

/**
 * POST /project/save
 * Save project by committing all changes and optionally tagging with a version
 */
router.post("/save", ensureAuthenticated, async (req, res) => {
  try {
    const { projectId } = req.body as SaveProjectRequest

    // Validation
    if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
      throw new HttpError("projectId is required and must be a non-empty string", HttpCode.BadRequest)
    }

    // Validate projectId format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9-_]+$/.test(projectId)) {
      throw new HttpError(
        "projectId must contain only alphanumeric characters, hyphens, and underscores",
        HttpCode.BadRequest,
      )
    }

    const projectPath = path.join(PROJECTS_DIR, projectId)
    console.log("Saving project at", projectPath)

    // Check if project exists
    try {
      await fs.access(projectPath)
    } catch (err: any) {
      throw new HttpError(`Project '${projectId}' does not exist`, HttpCode.NotFound)
    }

    // Git add all changes
    try {
      await execAsync("git add .", { cwd: projectPath })
    } catch (err: any) {
      throw new HttpError(`Failed to stage changes: ${err.message}`, HttpCode.ServerError)
    }

    // Check if there are changes to commit
    let hasChanges = false
    try {
      const { stdout } = await execAsync("git status --porcelain", { cwd: projectPath })
      hasChanges = stdout.trim().length > 0
    } catch (err: any) {
      throw new HttpError(`Failed to check git status: ${err.message}`, HttpCode.ServerError)
    }

    // Git commit
    let commitHash = ""
    if (hasChanges) {
      try {
        const timestamp = new Date().toISOString()
        await execAsync(`git commit -m "Save project at ${timestamp}"`, { cwd: projectPath })
        const { stdout } = await execAsync("git rev-parse HEAD", { cwd: projectPath })
        commitHash = stdout.trim()
      } catch (err: any) {
        throw new HttpError(`Failed to commit changes: ${err.message}`, HttpCode.ServerError)
      }
    }

    res.json({
      success: true,
      projectId: projectId,
      projectPath,
      hasChanges,
      commitHash: commitHash || null,
    })
  } catch (err: any) {
    if (err instanceof HttpError) {
      throw err
    }
    throw new HttpError(`Failed to save project: ${err.message}`, HttpCode.ServerError)
  }
})

/**
 * POST /project/deploy
 * Deploy project by committing all changes, tagging with a version, and pushing to remote
 */
router.post("/deploy", ensureAuthenticated, async (req, res) => {
  try {
    const { projectId, version } = req.body as DeployProjectRequest

    // Validation
    if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
      throw new HttpError("projectId is required and must be a non-empty string", HttpCode.BadRequest)
    }

    // Validate projectId format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9-_]+$/.test(projectId)) {
      throw new HttpError(
        "projectId must contain only alphanumeric characters, hyphens, and underscores",
        HttpCode.BadRequest,
      )
    }

    // Validate version parameter
    if (!version || typeof version !== "string" || version.trim() === "") {
      throw new HttpError("version is required and must be a non-empty string", HttpCode.BadRequest)
    }

    const projectPath = path.join(PROJECTS_DIR, projectId)
    console.log("Deploying project at", projectPath)

    // Check if project exists
    try {
      await fs.access(projectPath)
    } catch (err: any) {
      throw new HttpError(`Project '${projectId}' does not exist`, HttpCode.NotFound)
    }

    // Git add all changes
    try {
      await execAsync("git add .", { cwd: projectPath })
    } catch (err: any) {
      throw new HttpError(`Failed to stage changes: ${err.message}`, HttpCode.ServerError)
    }

    // Check if there are changes to commit
    let hasChanges = false
    try {
      const { stdout } = await execAsync("git status --porcelain", { cwd: projectPath })
      hasChanges = stdout.trim().length > 0
    } catch (err: any) {
      throw new HttpError(`Failed to check git status: ${err.message}`, HttpCode.ServerError)
    }

    // Git commit
    let commitHash = ""
    if (hasChanges) {
      try {
        const timestamp = new Date().toISOString()
        await execAsync(`git commit -m "Deploy project ${version} at ${timestamp}"`, { cwd: projectPath })
        const { stdout } = await execAsync("git rev-parse HEAD", { cwd: projectPath })
        commitHash = stdout.trim()
      } catch (err: any) {
        throw new HttpError(`Failed to commit changes: ${err.message}`, HttpCode.ServerError)
      }
    }

    // // Git tag with version
    // try {
    //   await execAsync(`git tag ${version}`, { cwd: projectPath })
    // } catch (err: any) {
    //   throw new HttpError(`Failed to create tag '${version}': ${err.message}`, HttpCode.ServerError)
    // }

    // Get current branch name
    let currentBranch = ""
    try {
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: projectPath })
      currentBranch = stdout.trim()
    } catch (err: any) {
      throw new HttpError(`Failed to get current branch: ${err.message}`, HttpCode.ServerError)
    }

    // Push current branch and tags to remote
    try {
      await execAsync(`git push origin ${currentBranch} --tags`, { cwd: projectPath })
    } catch (err: any) {
      throw new HttpError(`Failed to push to remote: ${err.message}`, HttpCode.ServerError)
    }

    res.json({
      success: true,
      projectId: projectId,
      projectPath,
      hasChanges,
      commitHash: commitHash || null,
      version: version,
      branch: currentBranch,
    })
  } catch (err: any) {
    if (err instanceof HttpError) {
      throw err
    }
    throw new HttpError(`Failed to deploy project: ${err.message}`, HttpCode.ServerError)
  }
})

/**
 * POST /project/executeCommand
 * Execute a VSCode command by connecting to the Unix socket server
 */
router.post("/executeCommand", ensureAuthenticated, async (req, res) => {
  try {
    const { projectId, commandJson } = req.body as ExecuteCommandRequest

    // Validation
    if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
      throw new HttpError("projectId is required and must be a non-empty string", HttpCode.BadRequest)
    }

    if (!commandJson || typeof commandJson !== "string") {
      throw new HttpError("commandJson is required and must be a string", HttpCode.BadRequest)
    }

    // Validate that commandJson is valid JSON
    let commandData: any
    try {
      commandData = JSON.parse(commandJson)
    } catch (err: any) {
      throw new HttpError("commandJson must be valid JSON", HttpCode.BadRequest)
    }

    // Construct Unix socket path based on projectId
    const tmpDir = os.tmpdir()
    const socketPath = path.join(tmpDir, `vscode-${projectId}.sock`)
    console.log(`Executing command for project '${projectId}' on socket '${socketPath}' with data:`, commandData)

    // Check if socket file exists
    let socketExists = false
    try {
      await fs.access(socketPath)
      socketExists = true
    } catch (err: any) {
      socketExists = false
    }

    // Handle special "ping" command
    if (commandData.command === "ping") {
      if (socketExists) {
        res.json({ status: "ok", message: "pong" })
      } else {
        res.status(503).json({
          error: `Server is still setting up for project '${projectId}'. Please retry.`,
          retryable: true,
        })
      }
      return
    }

    // For non-ping commands, socket must exist
    if (!socketExists) {
      throw new HttpError(`Server is still setting up for project '${projectId}'. Please retry.`, HttpCode.ServerError)
    }

    // Connect to Unix socket and send command
    const response = await new Promise<string>((resolve, reject) => {
      let client = clientCache.get(projectId)
      let responseData = ""
      let isResolved = false

      const handleResponse = (data: Buffer) => {
        responseData += data.toString()

        // Check if we have a complete message (ends with newline)
        if (responseData.includes("\n")) {
          // Remove the data listener to prevent further processing
          client?.removeListener("data", handleResponse)

          // Parse the response (remove the trailing newline)
          const completeMessage = responseData.trim()
          if (!isResolved) {
            isResolved = true
            resolve(completeMessage)
          }
        }
      }

      const handleEnd = () => {
        if (!isResolved) {
          isResolved = true
          console.log("Disconnected from Unix socket")
          resolve(responseData)
        }
      }

      const handleError = (err: Error) => {
        if (!isResolved) {
          isResolved = true
          console.error("Socket error:", err)
          clientCache.delete(projectId)
          reject(new HttpError(`Failed to connect to Unix socket: ${err.message}`, HttpCode.ServerError))
        }
      }

      const handleTimeout = () => {
        if (!isResolved) {
          isResolved = true
          client?.destroy()
          clientCache.delete(projectId)
          reject(new HttpError("Socket connection timeout", HttpCode.ServerError))
        }
      }

      if (client && !client.destroyed) {
        // Use existing connection
        console.log(`Using cached connection for project: ${projectId}`)

        // Set up listeners for this request
        client.on("data", handleResponse)
        client.once("end", handleEnd)
        client.once("error", handleError)

        try {
          client.write(commandJson + "\n")
        } catch (err: any) {
          clientCache.delete(projectId)
          handleError(err)
          return
        }
      } else {
        // Create new connection
        client = net.createConnection({ path: socketPath }, () => {
          console.log(`Connected to Unix socket: ${socketPath}`)
          client?.write(commandJson + "\n")
        })

        // Cache the client
        clientCache.set(projectId, client)

        // Set up listeners for this request
        client.on("data", handleResponse)
        client.once("end", handleEnd)
        client.once("error", handleError)

        // Clean up cache when connection closes (persistent listener)
        client.on("close", () => {
          console.log(`Connection closed for project: ${projectId}`)
          clientCache.delete(projectId)
        })

        // Set timeout for socket connection
        client.setTimeout(5000, handleTimeout)
      }
    })

    res.json({
      success: true,
      projectId: projectId,
      command: commandData,
      response: response || null,
    })
  } catch (err: any) {
    if (err instanceof HttpError) {
      throw err
    }
    throw new HttpError(`Failed to execute command: ${err.message}`, HttpCode.ServerError)
  }
})
