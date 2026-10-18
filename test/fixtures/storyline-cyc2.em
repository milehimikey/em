model "CY"
persona P
storyline "C" after "A" {
  slice "c0" {
    ui X0 @P
    command CC
    event EC
  }
  slice "c0b" {
    view V again from "EC"
    ui Y0 @P
  }
}
storyline "X" {
  slice "x1" {
    ui X1 @P
    command CX
    event EX
  }
}
storyline "A" {
  slice "a1" {
    ui A1 @P
    command CA
    event EA
  }
  slice "a2" {
    view V from "EA", "EX"
    ui A2 @P
  }
}
storyline "C" after "A" {
  slice "c3" {
    view T from "EX"
    ui Z @P
  }
}
