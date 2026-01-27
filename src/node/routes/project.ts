import { exec } from "child_process"
import { Router } from "express"
import { promises as fs } from "fs"
import * as path from "path"
import { promisify } from "util"
import { HttpCode, HttpError } from "../../common/http"
import { ensureAuthenticated } from "../http"
import { paths } from "../util"

const execAsync = promisify(exec)

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

const VALID_FRAMEWORKS = ["basic-html", "vite-vanilla", "vite-vue", "vite-react"]
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

    console.log('josh finish mkdir projects dir');
    // Create projects directory if it doesn't exist
    const result = await fs.mkdir(PROJECTS_DIR, { recursive: true })
    console.log('josh finish mkdir projects dir success', result);

    // Clone scaffolding repository
    try {
      console.log(`Cloning repository from ${SCAFFOLDING_REPO_URL} to ${projectPath}`)
      await execAsync(`git clone ${SCAFFOLDING_REPO_URL} "${projectPath}"`)
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
